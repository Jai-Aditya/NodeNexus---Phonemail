package mail

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

// PointerPatch changes a user's own flags on a message. Nil fields are left alone.
type PointerPatch struct {
	IsRead      *bool   `json:"is_read,omitempty"`
	IsFavourite *bool   `json:"is_favourite,omitempty"`
	Folder      *string `json:"folder,omitempty"` // inbox, spam, trash
}

// UpdatePointer sets flags on the user's pointer(s) to a message: in one chat, or all if convID is nil.
// Other people's pointers are never touched (spec 6.4, 6.6).
func (s *Service) UpdatePointer(ctx context.Context, userID, msgID int64, convID *int64, p PointerPatch) error {
	if p.Folder != nil && *p.Folder != "inbox" && *p.Folder != "spam" && *p.Folder != "trash" {
		return errBadRequest("folder must be inbox, spam or trash.")
	}
	return s.tx(ctx, func(tx pgx.Tx) error {
		// Old and new values of each changed pointer, so Home counters can be adjusted by
		// +1/-1 instead of recounting the whole chat on every star or read toggle.
		rows, err := tx.Query(ctx, `
			WITH old AS (
				SELECT conversation_id, is_read, is_favourite, folder FROM mailbox
				WHERE user_id = $1 AND message_id = $2 AND ($3::bigint IS NULL OR conversation_id = $3)
				FOR UPDATE
			)
			UPDATE mailbox mb SET
				is_read      = coalesce($4, mb.is_read),
				is_favourite = coalesce($5, mb.is_favourite),
				folder       = coalesce($6, mb.folder),
				deleted_at   = CASE WHEN $6 = 'trash' THEN coalesce(mb.deleted_at, now())
				                    WHEN $6 IS NOT NULL THEN NULL ELSE mb.deleted_at END
			FROM old
			WHERE mb.user_id = $1 AND mb.message_id = $2 AND mb.conversation_id = old.conversation_id
			RETURNING mb.conversation_id, old.folder, mb.folder, old.is_read, mb.is_read, old.is_favourite, mb.is_favourite`,
			userID, msgID, convID, p.IsRead, p.IsFavourite, p.Folder)
		if err != nil {
			return err
		}
		type change struct {
			conv                 int64
			oldFolder, newFolder string
			wasRead, isRead      bool
			wasFav, isFav        bool
		}
		changes, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (change, error) {
			var c change
			err := r.Scan(&c.conv, &c.oldFolder, &c.newFolder, &c.wasRead, &c.isRead, &c.wasFav, &c.isFav)
			return c, err
		})
		if err != nil {
			return err
		}
		if len(changes) == 0 {
			return errNotFound("Message not found.")
		}
		delta := func(was, is bool) int { // flag turned on: +1, off: -1
			switch {
			case is && !was:
				return 1
			case was && !is:
				return -1
			}
			return 0
		}
		for _, c := range changes {
			if c.oldFolder != c.newFolder {
				// Moving in or out of the inbox changes the preview and flags: recompute.
				if err := refreshChat(ctx, tx, userID, c.conv); err != nil {
					return err
				}
				continue
			}
			if c.newFolder != "inbox" {
				continue // Home counts only the inbox
			}
			unread, fav := -delta(c.wasRead, c.isRead), delta(c.wasFav, c.isFav)
			if unread == 0 && fav == 0 {
				continue
			}
			if _, err := tx.Exec(ctx, `UPDATE user_conversations SET
				unread_count = greatest(0, unread_count + $3), favourite_count = greatest(0, favourite_count + $4)
				WHERE user_id = $1 AND conversation_id = $2`, userID, c.conv, unread, fav); err != nil {
				return err
			}
		}
		return nil
	})
}

// MarkChatRead marks every message in a chat read for this user.
func (s *Service) MarkChatRead(ctx context.Context, userID, convID int64) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		// Nothing unread (the usual case when reopening a chat): no writes at all.
		tag, err := tx.Exec(ctx, `UPDATE user_conversations SET unread_count = 0
			WHERE user_id = $1 AND conversation_id = $2 AND unread_count <> 0`, userID, convID)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE mailbox SET is_read = true
			WHERE user_id = $1 AND conversation_id = $2 AND NOT is_read`, userID, convID)
		return err
	})
}

// EmptyTrash permanently removes the user's pointers in Trash.
func (s *Service) EmptyTrash(ctx context.Context, userID int64) (int64, error) {
	var n int64
	err := s.tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `DELETE FROM mailbox WHERE user_id = $1 AND folder = 'trash'
			RETURNING conversation_id`, userID)
		if err != nil {
			return err
		}
		convs, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return err
		}
		n = int64(len(convs))
		done := map[int64]bool{}
		for _, c := range convs {
			if !done[c] {
				done[c] = true
				if err := refreshChat(ctx, tx, userID, c); err != nil {
					return err
				}
			}
		}
		return nil
	})
	return n, err
}

// refreshChat recomputes a user's Home row for one chat from their pointers.
func refreshChat(ctx context.Context, tx pgx.Tx, userID, convID int64) error {
	_, err := tx.Exec(ctx, `
		WITH mine AS (
			SELECT mb.*, m.snippet, m.has_attachments
			FROM mailbox mb JOIN messages m ON m.id = mb.message_id
			WHERE mb.user_id = $1 AND mb.conversation_id = $2 AND mb.folder = 'inbox'
		), latest AS (
			SELECT message_id, received_at, snippet FROM mine ORDER BY received_at DESC, message_id DESC LIMIT 1
		)
		UPDATE user_conversations uc SET
			unread_count    = (SELECT count(*) FROM mine WHERE NOT is_read),
			favourite_count = (SELECT count(*) FROM mine WHERE is_favourite),
			has_attachments = EXISTS (SELECT 1 FROM mine WHERE has_attachments),
			last_message_id = (SELECT message_id FROM latest),
			snippet         = coalesce((SELECT snippet FROM latest), ''),
			last_message_at = coalesce((SELECT received_at FROM latest), uc.last_message_at)
		WHERE uc.user_id = $1 AND uc.conversation_id = $2`, userID, convID)
	return err
}

// Cleanup empties Trash items older than the retention period, then deletes messages
// nobody points to any more (and their files). Runs in the background.
func (s *Service) Cleanup(ctx context.Context) error {
	cutoff := time.Now().Add(-s.TrashRetention)
	err := s.tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `DELETE FROM mailbox WHERE folder = 'trash' AND deleted_at < $1
			RETURNING user_id, conversation_id`, cutoff)
		if err != nil {
			return err
		}
		type uc struct{ user, conv int64 }
		pairs, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (uc, error) {
			var p uc
			return p, r.Scan(&p.user, &p.conv)
		})
		if err != nil {
			return err
		}
		done := map[uc]bool{}
		for _, p := range pairs {
			if !done[p] {
				done[p] = true
				if err := refreshChat(ctx, tx, p.user, p.conv); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	// Orphans: no pointer, and not the parent or root of another message. Repeat so
	// whole unreferenced threads disappear leaf-first.
	var files []string
	for {
		var ids []int64
		err := s.tx(ctx, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `
				SELECT m.id FROM messages m
				WHERE NOT EXISTS (SELECT 1 FROM mailbox mb WHERE mb.message_id = m.id)
				  AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.parent_id = m.id)
				  AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.root_id = m.id AND c.id <> m.id)
				LIMIT 500 FOR UPDATE SKIP LOCKED`)
			if err != nil {
				return err
			}
			if ids, err = pgx.CollectRows(rows, pgx.RowTo[int64]); err != nil || len(ids) == 0 {
				return err
			}
			prow, err := tx.Query(ctx, `SELECT storage_path FROM attachments WHERE message_id = ANY($1)`, ids)
			if err != nil {
				return err
			}
			paths, err := pgx.CollectRows(prow, pgx.RowTo[string])
			if err != nil {
				return err
			}
			files = append(files, paths...)
			_, err = tx.Exec(ctx, `DELETE FROM messages WHERE id = ANY($1)`, ids)
			return err
		})
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			break
		}
	}
	s.removeUnreferencedFiles(ctx, files)
	return nil
}

// RunCleanup calls Cleanup every interval until ctx is cancelled.
func (s *Service) RunCleanup(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := s.Cleanup(ctx); err != nil && ctx.Err() == nil {
			log.Printf("cleanup: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
