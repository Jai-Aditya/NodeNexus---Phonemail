package mail

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
)

// AddDraftAttachment stores an uploaded file and attaches it to a draft.
// Files are stored once per content (named by their SHA-256), so identical files share storage.
func (s *Service) AddDraftAttachment(ctx context.Context, userID, draftID int64, filename, contentType string, r io.Reader) (AttachmentInfo, error) {
	var info AttachmentInfo
	var owner int64
	err := s.DB.QueryRow(ctx, `SELECT user_id FROM drafts WHERE id = $1`, draftID).Scan(&owner)
	if err == pgx.ErrNoRows || (err == nil && owner != userID) {
		return info, errNotFound("Draft not found.")
	}
	if err != nil {
		return info, err
	}
	lim := s.limits()
	var files int
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE draft_id = $1`, draftID).Scan(&files); err != nil {
		return info, err
	}
	if files >= lim.MaxDraftFiles {
		return info, errConflict("too_many_files", "A message can have at most %d attachments.", lim.MaxDraftFiles)
	}
	used, err := s.StorageUsed(ctx, userID)
	if err != nil {
		return info, err
	}
	if used >= lim.MaxUserStorage {
		return info, s.quotaError(lim)
	}

	sum, rel, n, err := s.storeFile(r)
	if err != nil {
		return info, err
	}
	if used+n > lim.MaxUserStorage {
		s.removeUnreferencedFiles(ctx, []string{rel})
		return info, s.quotaError(lim)
	}

	filename = cleanFilename(filename)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	err = s.DB.QueryRow(ctx, `INSERT INTO attachments (draft_id, filename, content_type, size_bytes, sha256, storage_path)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, draftID, filename, contentType, n, sum, rel).Scan(&info.ID)
	if err != nil {
		return info, err
	}
	_, _ = s.DB.Exec(ctx, `UPDATE drafts SET updated_at = now() WHERE id = $1`, draftID)
	info.Filename, info.ContentType, info.SizeBytes = filename, contentType, n
	return info, nil
}

// storeFile streams a file to disk once per content (named by its SHA-256, so identical
// files share storage) and returns its hash, path under AttachmentDir and size.
func (s *Service) storeFile(r io.Reader) (sum, rel string, n int64, err error) {
	if err := os.MkdirAll(s.AttachmentDir, 0o750); err != nil {
		return "", "", 0, err
	}
	tmp, err := os.CreateTemp(s.AttachmentDir, "upload-*")
	if err != nil {
		return "", "", 0, err
	}
	defer os.Remove(tmp.Name()) // no-op once renamed
	h := sha256.New()
	n, err = io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, s.MaxAttachment+1))
	tmp.Close()
	if err != nil {
		return "", "", 0, err
	}
	if n > s.MaxAttachment {
		return "", "", 0, &Error{413, "too_large", "That file is too large."}
	}
	sum = hex.EncodeToString(h.Sum(nil))
	rel = filepath.Join(sum[:2], sum)
	dst := filepath.Join(s.AttachmentDir, rel)
	if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
			return "", "", 0, err
		}
		if err := os.Rename(tmp.Name(), dst); err != nil {
			return "", "", 0, err
		}
	}
	return sum, rel, n, nil
}

func (s *Service) DeleteDraftAttachment(ctx context.Context, userID, draftID, attachmentID int64) error {
	var path string
	err := s.DB.QueryRow(ctx, `DELETE FROM attachments a USING drafts d
		WHERE a.id = $1 AND a.draft_id = $2 AND d.id = a.draft_id AND d.user_id = $3
		RETURNING a.storage_path`, attachmentID, draftID, userID).Scan(&path)
	if err == pgx.ErrNoRows {
		return errNotFound("Attachment not found.")
	}
	if err != nil {
		return err
	}
	s.removeUnreferencedFiles(ctx, []string{path})
	return nil
}

// OpenAttachment returns a file the user may see: on their own draft, or on a message they have.
func (s *Service) OpenAttachment(ctx context.Context, userID, attachmentID int64) (AttachmentInfo, *os.File, error) {
	var info AttachmentInfo
	var rel string
	err := s.DB.QueryRow(ctx, `
		SELECT a.id, a.filename, a.content_type, a.size_bytes, a.storage_path
		FROM attachments a
		WHERE a.id = $1 AND (
			EXISTS (SELECT 1 FROM drafts d WHERE d.id = a.draft_id AND d.user_id = $2)
			OR EXISTS (SELECT 1 FROM mailbox mb WHERE mb.message_id = a.message_id AND mb.user_id = $2))`,
		attachmentID, userID).Scan(&info.ID, &info.Filename, &info.ContentType, &info.SizeBytes, &rel)
	if err == pgx.ErrNoRows {
		return info, nil, errNotFound("Attachment not found.")
	}
	if err != nil {
		return info, nil, err
	}
	f, err := os.Open(filepath.Join(s.AttachmentDir, rel))
	return info, f, err
}

func (s *Service) attachmentsFor(ctx context.Context, column string, id int64) ([]AttachmentInfo, error) {
	rows, err := s.DB.Query(ctx, `SELECT id, filename, content_type, size_bytes FROM attachments
		WHERE `+column+` = $1 ORDER BY id`, id) // column is a constant chosen by this package
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[AttachmentInfo])
}

// draftAttachments loads the attachments of many drafts in one query, keyed by draft id.
func (s *Service) draftAttachments(ctx context.Context, draftIDs []int64) (map[int64][]AttachmentInfo, error) {
	out := map[int64][]AttachmentInfo{}
	rows, err := s.DB.Query(ctx, `SELECT draft_id, id, filename, content_type, size_bytes FROM attachments
		WHERE draft_id = ANY($1) ORDER BY id`, draftIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d int64
		var a AttachmentInfo
		if err := rows.Scan(&d, &a.ID, &a.Filename, &a.ContentType, &a.SizeBytes); err != nil {
			return nil, err
		}
		out[d] = append(out[d], a)
	}
	return out, rows.Err()
}

// forwardableAttachments checks the user can see a message and counts its attachments.
func (s *Service) forwardableAttachments(ctx context.Context, tx pgx.Tx, userID, msgID int64) (int, error) {
	var ok bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mailbox WHERE user_id = $1 AND message_id = $2)`,
		userID, msgID).Scan(&ok); err != nil {
		return 0, err
	}
	if !ok {
		return 0, errNotFound("The message to forward wasn't found.")
	}
	var n int
	err := tx.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE message_id = $1`, msgID).Scan(&n)
	return n, err
}

// removeUnreferencedFiles deletes stored files no attachment row points to any more.
func (s *Service) removeUnreferencedFiles(ctx context.Context, paths []string) {
	for _, rel := range paths {
		var used bool
		if err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM attachments WHERE storage_path = $1)`, rel).Scan(&used); err != nil || used {
			continue
		}
		_ = os.Remove(filepath.Join(s.AttachmentDir, rel))
	}
}

func cleanFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == '"' {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == "/" {
		return "attachment"
	}
	return name
}

// StorageUsed is how many bytes of attachments a user has: files on their drafts and on
// the messages they sent (forwarding counts too). Identical files are stored once on
// disk, but each person is charged for what they uploaded, so nobody can fill the disk.
func (s *Service) StorageUsed(ctx context.Context, userID int64) (int64, error) {
	var used int64
	err := s.DB.QueryRow(ctx, `SELECT
		COALESCE((SELECT sum(a.size_bytes) FROM drafts d JOIN attachments a ON a.draft_id = d.id WHERE d.user_id = $1), 0) +
		COALESCE((SELECT sum(a.size_bytes) FROM messages m JOIN attachments a ON a.message_id = m.id WHERE m.sender_id = $1), 0)`,
		userID).Scan(&used)
	return used, err
}

func (s *Service) quotaError(lim Limits) error {
	return &Error{413, "storage_full", fmt.Sprintf(
		"You've used your %d MB of attachment space. Delete some sent mail with files, or drafts, to free space.",
		lim.MaxUserStorage>>20)}
}
