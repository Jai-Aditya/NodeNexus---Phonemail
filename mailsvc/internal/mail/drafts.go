package mail

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// DraftInput is what the client autosaves.
type DraftInput struct {
	ConversationID *int64     `json:"conversation_id,omitempty"`
	ParentID       *int64     `json:"parent_id,omitempty"`
	Recipients     Recipients `json:"recipients"`
	Subject        string     `json:"subject"`
	BodyText       string     `json:"body_text"`
	BodyHTML       string     `json:"body_html"`
	// ForwardedFromID forwards a message the user has: its files are sent along.
	ForwardedFromID *int64 `json:"forwarded_from_id,omitempty"`
}

const draftCols = `id, conversation_id, parent_id, recipients, subject, body_text, body_html, updated_at,
	forwarded_from_id, send_at, send_error`

func scanDraft(row pgx.Row) (Draft, error) {
	var d Draft
	var raw []byte
	err := row.Scan(&d.ID, &d.ConversationID, &d.ParentID, &raw, &d.Subject, &d.BodyText, &d.BodyHTML, &d.UpdatedAt,
		&d.ForwardedFromID, &d.SendAt, &d.SendError)
	if err == nil && len(raw) > 0 {
		err = json.Unmarshal(raw, &d.Recipients)
	}
	return d, err
}

func (s *Service) ListDrafts(ctx context.Context, userID int64) ([]Draft, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+draftCols+` FROM drafts WHERE user_id = $1 ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Draft{}
	for rows.Next() {
		d, err := scanDraft(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	ids := make([]int64, len(out))
	for i := range out {
		ids[i] = out[i].ID
	}
	files, err := s.draftAttachments(ctx, ids) // one query for all drafts
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Attachments = files[out[i].ID]
	}
	return out, nil
}

func (s *Service) GetDraft(ctx context.Context, userID, draftID int64) (Draft, error) {
	d, err := scanDraft(s.DB.QueryRow(ctx, `SELECT `+draftCols+` FROM drafts WHERE id = $1 AND user_id = $2`, draftID, userID))
	if err == pgx.ErrNoRows {
		return d, errNotFound("Draft not found.")
	}
	if err != nil {
		return d, err
	}
	d.Attachments, err = s.attachmentsFor(ctx, "draft_id", d.ID)
	return d, err
}

// SaveDraft creates a draft (draftID nil) or overwrites one (autosave).
func (s *Service) SaveDraft(ctx context.Context, userID int64, draftID *int64, in DraftInput) (Draft, error) {
	var d Draft
	lim := s.limits()
	if err := cleanContent(&in.Subject, &in.BodyText, &in.BodyHTML); err != nil {
		return d, err
	}
	r := in.Recipients
	if n := len(r.To) + len(r.Cc) + len(r.Bcc); n > lim.MaxRecipients {
		return d, errBadRequest("A message can have at most %d recipients (To, Cc and Bcc together).", lim.MaxRecipients)
	}
	err := s.tx(ctx, func(tx pgx.Tx) error {
		if draftID == nil {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM drafts WHERE user_id = $1`, userID).Scan(&n); err != nil {
				return err
			}
			if n >= lim.MaxDrafts {
				return errConflict("too_many_drafts", "You have %d drafts. Send or delete some first.", n)
			}
		}
		if in.ConversationID != nil {
			var ok bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversation_participants
				WHERE conversation_id = $1 AND user_id = $2)`, *in.ConversationID, userID).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return errNotFound("Chat not found.")
			}
		}
		if draftID != nil {
			var scheduled bool
			err := tx.QueryRow(ctx, `SELECT send_at IS NOT NULL FROM drafts WHERE id = $1 AND user_id = $2`, *draftID, userID).Scan(&scheduled)
			if err == pgx.ErrNoRows {
				return errNotFound("Draft not found.")
			}
			if err != nil {
				return err
			}
			if scheduled {
				return ErrDraftScheduled
			}
		}
		if in.ForwardedFromID != nil {
			var ok bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mailbox WHERE user_id = $1 AND message_id = $2)`,
				userID, *in.ForwardedFromID).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return errNotFound("The message being forwarded wasn't found.")
			}
		}
		if in.ParentID != nil {
			if in.ConversationID == nil {
				return errBadRequest("A reply draft needs conversation_id.")
			}
			var ok bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mailbox
				WHERE user_id = $1 AND message_id = $2 AND conversation_id = $3)`,
				userID, *in.ParentID, *in.ConversationID).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return errNotFound("Message not found in this chat.")
			}
		}
		recips, err := json.Marshal(in.Recipients)
		if err != nil {
			return err
		}
		var row pgx.Row
		if draftID == nil {
			row = tx.QueryRow(ctx, `INSERT INTO drafts (user_id, conversation_id, parent_id, recipients, subject, body_text, body_html, forwarded_from_id)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING `+draftCols,
				userID, in.ConversationID, in.ParentID, recips, in.Subject, in.BodyText, in.BodyHTML, in.ForwardedFromID)
		} else {
			row = tx.QueryRow(ctx, `UPDATE drafts SET conversation_id = $3, parent_id = $4, recipients = $5,
				subject = $6, body_text = $7, body_html = $8, forwarded_from_id = $9, send_error = '', updated_at = now()
				WHERE id = $1 AND user_id = $2 RETURNING `+draftCols,
				*draftID, userID, in.ConversationID, in.ParentID, recips, in.Subject, in.BodyText, in.BodyHTML, in.ForwardedFromID)
		}
		d, err = scanDraft(row)
		if err == pgx.ErrNoRows {
			return errNotFound("Draft not found.")
		}
		return err
	})
	if err != nil {
		return d, err
	}
	d.Attachments, err = s.attachmentsFor(ctx, "draft_id", d.ID)
	return d, err
}

func (s *Service) DeleteDraft(ctx context.Context, userID, draftID int64) error {
	var paths []string
	err := s.tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT a.storage_path FROM attachments a
			JOIN drafts d ON d.id = a.draft_id WHERE d.id = $1 AND d.user_id = $2`, draftID, userID)
		if err != nil {
			return err
		}
		if paths, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM drafts WHERE id = $1 AND user_id = $2`, draftID, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound("Draft not found.")
		}
		return nil
	})
	if err == nil {
		s.removeUnreferencedFiles(ctx, paths)
	}
	return err
}

// SendDraft sends a draft now: as a reply if it has a parent, otherwise as a new message.
// A draft waiting for a scheduled send can't be sent this way; take it back first.
func (s *Service) SendDraft(ctx context.Context, userID, draftID int64) (SendResult, error) {
	return s.sendDraft(ctx, userID, draftID, sendOpts{})
}

func (s *Service) sendDraft(ctx context.Context, userID, draftID int64, o sendOpts) (SendResult, error) {
	d, err := s.GetDraft(ctx, userID, draftID)
	if err != nil {
		return SendResult{}, err
	}
	if d.SendAt != nil && !o.scheduled {
		return SendResult{}, ErrDraftScheduled
	}
	if d.ParentID != nil {
		return s.Reply(ctx, userID, *d.ParentID, ReplyRequest{
			ConversationID: derefOr(d.ConversationID, 0), BodyText: d.BodyText, BodyHTML: d.BodyHTML, DraftID: &d.ID, sendOpts: o,
		})
	}
	return s.Send(ctx, userID, SendRequest{
		Recipients: d.Recipients, ConversationID: d.ConversationID,
		Subject: d.Subject, BodyText: d.BodyText, BodyHTML: d.BodyHTML, DraftID: &d.ID,
		ForwardedFromID: d.ForwardedFromID, sendOpts: o,
	})
}

// lockDraft checks the draft belongs to the user, locks it, and counts its attachments.
// For the scheduler (scheduled set), the draft must still be due: if its owner took it
// back a moment ago (Undo), it is not sent.
func lockDraft(ctx context.Context, tx pgx.Tx, userID, draftID int64, scheduled bool) (int, error) {
	var id int64
	err := tx.QueryRow(ctx, `SELECT id FROM drafts WHERE id = $1 AND user_id = $2
		AND (NOT $3 OR send_at <= now()) FOR UPDATE`, draftID, userID, scheduled).Scan(&id)
	if err == pgx.ErrNoRows && scheduled {
		return 0, errNotDue
	}
	if err == pgx.ErrNoRows {
		return 0, errNotFound("Draft not found.")
	}
	if err != nil {
		return 0, err
	}
	var n int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE draft_id = $1`, draftID).Scan(&n)
	return n, err
}

// consumeDraft moves the draft's attachments to the sent message and deletes the draft.
func consumeDraft(ctx context.Context, tx pgx.Tx, draftID, msgID int64) error {
	if _, err := tx.Exec(ctx, `UPDATE attachments SET message_id = $2, draft_id = NULL WHERE draft_id = $1`, draftID, msgID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM drafts WHERE id = $1`, draftID)
	return err
}

func derefOr(p *int64, def int64) int64 {
	if p == nil {
		return def
	}
	return *p
}
