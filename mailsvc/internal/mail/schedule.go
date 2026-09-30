package mail

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

// MaxScheduleAhead is how far ahead an email can be scheduled.
const MaxScheduleAhead = 365 * 24 * time.Hour

// ScheduleDraft sets a draft to be sent at a time: later (scheduled send), or a few seconds
// from now (undo send). Everything is checked first, exactly as a send would be, so the
// sender hears about a wrong address or a missing group name right away, not later.
func (s *Service) ScheduleDraft(ctx context.Context, userID, draftID int64, at time.Time) (Draft, error) {
	now := time.Now()
	if at.Before(now) {
		at = now
	}
	if at.After(now.Add(MaxScheduleAhead)) {
		return Draft{}, errBadRequest("Emails can be scheduled at most a year ahead.")
	}
	if _, err := s.sendDraft(ctx, userID, draftID, sendOpts{dryRun: true}); err != nil {
		return Draft{}, err
	}
	d, err := scanDraft(s.DB.QueryRow(ctx, `UPDATE drafts SET send_at = $3, send_error = '', updated_at = now()
		WHERE id = $1 AND user_id = $2 RETURNING `+draftCols, draftID, userID, at))
	if err == pgx.ErrNoRows {
		return d, errNotFound("Draft not found.")
	}
	if err != nil {
		return d, err
	}
	d.Attachments, err = s.attachmentsFor(ctx, "draft_id", d.ID)
	return d, err
}

// UnscheduleDraft takes back a draft waiting to be sent (Undo, or cancel a scheduled send):
// it becomes an ordinary draft again. Too late if it has already gone.
func (s *Service) UnscheduleDraft(ctx context.Context, userID, draftID int64) (Draft, error) {
	// If the scheduler is sending it right now, this waits for its row lock; the draft is
	// then gone (sent), or still here (the send failed and was put back).
	d, err := scanDraft(s.DB.QueryRow(ctx, `UPDATE drafts SET send_at = NULL, updated_at = now()
		WHERE id = $1 AND user_id = $2 RETURNING `+draftCols, draftID, userID))
	if err == pgx.ErrNoRows {
		return d, ErrAlreadySent // drafts are only deleted by sending or by their owner
	}
	if err != nil {
		return d, err
	}
	d.Attachments, err = s.attachmentsFor(ctx, "draft_id", d.ID)
	return d, err
}

// sendDue sends the drafts whose time has come. A draft that can't be sent (the person
// deleted their account, the group was left...) goes back to being a draft, with the
// reason in send_error, and its owner's apps are told.
func (s *Service) sendDue(ctx context.Context) (int, error) {
	rows, err := s.DB.Query(ctx, `SELECT id, user_id FROM drafts WHERE send_at <= now() ORDER BY send_at LIMIT 50`)
	if err != nil {
		return 0, err
	}
	type due struct{ id, user int64 }
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (due, error) {
		var d due
		return d, r.Scan(&d.id, &d.user)
	})
	if err != nil {
		return 0, err
	}
	sent := 0
	for _, d := range list {
		_, err := s.sendDraft(ctx, d.user, d.id, sendOpts{scheduled: true})
		var me *Error
		switch {
		case err == nil:
			sent++
		case errors.Is(err, errNotDue):
			// Taken back (Undo) or moved while we were looking: nothing to do.
		case errors.As(err, &me):
			if _, err := s.DB.Exec(ctx, `UPDATE drafts SET send_at = NULL, send_error = $2 WHERE id = $1`, d.id, me.Message); err != nil {
				return sent, err
			}
			_ = s.notifyUser(ctx, d.user, "draft_failed", 0)
		default:
			// A database hiccup: try again in a minute rather than every tick.
			log.Printf("scheduled send of draft %d: %v", d.id, err)
			if _, err := s.DB.Exec(ctx, `UPDATE drafts SET send_at = now() + interval '1 minute' WHERE id = $1 AND send_at IS NOT NULL`, d.id); err != nil {
				return sent, err
			}
		}
	}
	return sent, nil
}

// RunScheduler sends scheduled emails and wakes snoozed chats, checking every tick
// (a couple of seconds, so "Undo" windows end on time). Both checks are one indexed
// query when there is nothing to do.
func (s *Service) RunScheduler(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if _, err := s.sendDue(ctx); err != nil && ctx.Err() == nil {
			log.Printf("scheduler: %v", err)
		}
		if _, err := s.wakeSnoozed(ctx); err != nil && ctx.Err() == nil {
			log.Printf("snooze: %v", err)
		}
	}
}
