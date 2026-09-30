package mail

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

// DeleteAccount erases a person (decided 30 Sep): their number, profile, aliases, sessions,
// push subscriptions, drafts and their own copies of mail. Mail they sent stays with the
// people who received it, from "Deleted account" (messages.sender_id becomes NULL). They
// leave every group first, as if they had left themselves, so admins are handed over and
// the others see "Deleted account left". Returns the phone number, for the API to clean up.
//
// The spec gives the users table to the API service; deleting the row here keeps the whole
// erasure in one transaction with the mail side (the API's own tables go with it by cascade).
func (s *Service) DeleteAccount(ctx context.Context, userID int64) (string, error) {
	var phone string
	var files []string
	err := s.tx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT phone FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&phone); err != nil {
			if err == pgx.ErrNoRows {
				return errNotFound("Account not found.")
			}
			return err
		}
		rows, err := tx.Query(ctx, `SELECT c.id, c.name FROM conversations c
			JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = $1 AND p.left_at IS NULL
			WHERE c.kind = 'group' ORDER BY c.id FOR UPDATE OF c`, userID)
		if err != nil {
			return err
		}
		type grp struct {
			ID   int64
			Name string
		}
		groups, err := pgx.CollectRows(rows, pgx.RowToStructByPos[grp])
		if err != nil {
			return err
		}
		for _, g := range groups {
			if err := leave(ctx, tx, g.ID, userID, userID, g.Name, true); err != nil {
				return err
			}
		}
		prow, err := tx.Query(ctx, `SELECT a.storage_path FROM attachments a
			JOIN drafts d ON d.id = a.draft_id WHERE d.user_id = $1`, userID)
		if err != nil {
			return err
		}
		if files, err = pgx.CollectRows(prow, pgx.RowTo[string]); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
		return err
	})
	if err != nil {
		return "", err
	}
	s.removeUnreferencedFiles(ctx, files)
	// Mail only this person still had is now unreferenced: remove it (and its files) now
	// rather than at the next hourly clean-up.
	go func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := s.Cleanup(c); err != nil {
			log.Printf("cleanup after account deletion: %v", err)
		}
	}()
	return phone, nil
}

// exportBatch is how many messages Export reads and writes at a time.
const exportBatch = 200

// Export writes everything PhoneMail holds about a person as one JSON document: account,
// aliases, groups, drafts, and every message they have (full text, recipients as they may
// see them, attachment details; the files themselves are downloaded separately by id).
// Messages are written in batches, so a large mailbox never sits in memory as a whole.
func (s *Service) Export(ctx context.Context, userID int64, out io.Writer) error {
	var acct struct {
		UserID      int64     `json:"user_id"`
		Phone       string    `json:"phone"`
		Address     string    `json:"address"`
		DisplayName string    `json:"display_name"`
		Language    string    `json:"language"`
		CreatedVia  string    `json:"created_via"`
		HasPush     bool      `json:"has_push"`
		Signature   string    `json:"signature"`
		UndoSend    int       `json:"undo_send_seconds"`
		ExportedAt  time.Time `json:"exported_at"`
	}
	var local string
	if err := s.DB.QueryRow(ctx, `SELECT id, phone, phone_local, display_name, language, created_via, has_push,
		signature, undo_send_seconds FROM users WHERE id = $1`, userID).Scan(&acct.UserID, &acct.Phone, &local, &acct.DisplayName,
		&acct.Language, &acct.CreatedVia, &acct.HasPush, &acct.Signature, &acct.UndoSend); err != nil {
		return err
	}
	acct.Address, acct.ExportedAt = s.AddressOf(local), time.Now().UTC()
	rows, err := s.DB.Query(ctx, `SELECT alias FROM aliases WHERE user_id = $1 ORDER BY alias`, userID)
	if err != nil {
		return err
	}
	aliases, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	groups, err := s.ListGroups(ctx, userID)
	if err != nil {
		return err
	}
	drafts, err := s.ListDrafts(ctx, userID)
	if err != nil {
		return err
	}
	blocked, err := s.Blocks(ctx, userID)
	if err != nil {
		return err
	}

	w := bufio.NewWriter(out)
	enc := json.NewEncoder(w)
	w.WriteString("{")
	for _, f := range []struct {
		name string
		v    any
	}{{"account", acct}, {"aliases", aliases}, {"groups", groups}, {"drafts", drafts}, {"blocked", blocked}} {
		w.WriteString(`"` + f.name + `":`)
		if err := enc.Encode(f.v); err != nil {
			return err
		}
		w.WriteString(",")
	}
	w.WriteString(`"messages":[`)
	var after time.Time
	var afterMsg, afterConv int64
	first := true
	for {
		rows, err := s.DB.Query(ctx, `SELECT `+fullMessageCols+`, mb.received_at`+messageFrom+`
			WHERE mb.user_id = $1 AND (mb.received_at, mb.message_id, mb.conversation_id) > ($2, $3, $4)
			ORDER BY mb.received_at, mb.message_id, mb.conversation_id LIMIT $5`,
			userID, after, afterMsg, afterConv, exportBatch)
		if err != nil {
			return err
		}
		var batch []MessageView
		var lastAt time.Time
		for rows.Next() {
			var v MessageView
			var local string
			var textLen, htmlLen int
			if err := rows.Scan(&v.ID, &v.ConversationID, &v.Sender.UserID, &local, &v.Sender.DisplayName, &v.Sender.AvatarURL,
				&v.Subject, &v.BodyText, &v.BodyHTML, &textLen, &htmlLen, &v.Snippet, &v.ParentID, &v.RootID, &v.Depth,
				&v.ForwardedFromID, &v.HasAttachments, &v.SentAt,
				&v.Folder, &v.IsRead, &v.IsFavourite, &v.IsReplied, &v.IsMine, &lastAt); err != nil {
				rows.Close()
				return err
			}
			if local != "" {
				v.Sender.Address = s.AddressOf(local)
			}
			batch = append(batch, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(batch) == 0 {
			break
		}
		if err := s.fillDetails(ctx, userID, batch); err != nil {
			return err
		}
		for _, m := range batch {
			if !first {
				w.WriteString(",")
			}
			first = false
			if err := enc.Encode(m); err != nil {
				return err
			}
		}
		// The next batch starts after the last pointer written. (One message in two chats
		// has two pointers with the same time and id; the chat id keeps them apart.)
		last := batch[len(batch)-1]
		after, afterMsg, afterConv = lastAt, last.ID, last.ConversationID
		if len(batch) < exportBatch {
			break
		}
	}
	w.WriteString("]}")
	return w.Flush()
}
