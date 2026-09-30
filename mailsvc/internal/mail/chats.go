package mail

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// MaxChatActions is how many chats one action may change at once (select all, then act).
const MaxChatActions = 100

// ChatActionRequest is something done to whole chats from the Home list (one or many).
type ChatActionRequest struct {
	ConversationIDs []int64 `json:"conversation_ids"`
	// Action: archive, unarchive, trash, read, unread, mute, unmute, snooze, unsnooze.
	Action string     `json:"action"`
	Until  *time.Time `json:"until,omitempty"` // for snooze
}

// ChatAction applies an action to the user's own view of some chats. Nobody else's
// view changes. Chats the user isn't in are skipped; if none match, it's "not found".
func (s *Service) ChatAction(ctx context.Context, userID int64, req ChatActionRequest) (int, error) {
	ids := req.ConversationIDs
	if len(ids) == 0 {
		return 0, errBadRequest("conversation_ids is empty.")
	}
	if len(ids) > MaxChatActions {
		return 0, errBadRequest("At most %d chats at a time.", MaxChatActions)
	}
	if req.Action == "snooze" {
		if req.Until == nil || !req.Until.After(time.Now()) {
			return 0, errBadRequest("Snooze needs a time in the future (until).")
		}
		if req.Until.After(time.Now().AddDate(1, 0, 0)) {
			return 0, errBadRequest("Snooze for at most a year.")
		}
	}
	var n int
	err := s.tx(ctx, func(tx pgx.Tx) error {
		// Lock the user's rows in a fixed order, as delivery does.
		rows, err := tx.Query(ctx, `SELECT conversation_id FROM user_conversations
			WHERE user_id = $1 AND conversation_id = ANY($2) ORDER BY conversation_id FOR UPDATE`, userID, ids)
		if err != nil {
			return err
		}
		convs, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return err
		}
		if len(convs) == 0 {
			return errNotFound("Chat not found.")
		}
		n = len(convs)
		set := func(sql string) error {
			_, err := tx.Exec(ctx, `UPDATE user_conversations SET `+sql+`
				WHERE user_id = $1 AND conversation_id = ANY($2)`, userID, convs)
			return err
		}
		switch req.Action {
		case "archive":
			return set(`hidden = true, snoozed_until = NULL`)
		case "unarchive":
			return set(`hidden = false, snoozed_until = NULL`)
		case "mute":
			return set(`muted = true`)
		case "unmute":
			return set(`muted = false`)
		case "snooze":
			_, err := tx.Exec(ctx, `UPDATE user_conversations SET snoozed_until = $3, hidden = false
				WHERE user_id = $1 AND conversation_id = ANY($2)`, userID, convs, *req.Until)
			return err
		case "unsnooze":
			return set(`snoozed_until = NULL`)
		case "read":
			if _, err := tx.Exec(ctx, `UPDATE mailbox SET is_read = true
				WHERE user_id = $1 AND conversation_id = ANY($2) AND NOT is_read`, userID, convs); err != nil {
				return err
			}
			return set(`unread_count = 0`)
		case "unread":
			// Gmail-style: the newest email in the chat becomes unread again.
			if _, err := tx.Exec(ctx, `UPDATE mailbox mb SET is_read = false
				FROM user_conversations uc
				WHERE uc.user_id = $1 AND uc.conversation_id = ANY($2)
				  AND mb.user_id = uc.user_id AND mb.conversation_id = uc.conversation_id
				  AND mb.message_id = uc.last_message_id AND mb.folder = 'inbox'`, userID, convs); err != nil {
				return err
			}
		case "trash":
			// Every email of the chat to Trash; the chat leaves Home until new mail comes.
			if _, err := tx.Exec(ctx, `UPDATE mailbox SET folder = 'trash', deleted_at = now()
				WHERE user_id = $1 AND conversation_id = ANY($2) AND folder = 'inbox'`, userID, convs); err != nil {
				return err
			}
			if err := set(`hidden = true, snoozed_until = NULL`); err != nil {
				return err
			}
		default:
			return errBadRequest("action must be archive, unarchive, trash, read, unread, mute, unmute, snooze or unsnooze.")
		}
		for _, c := range convs {
			if err := refreshChat(ctx, tx, userID, c); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	// The user's other tabs and phones update their lists.
	_ = s.notifyUser(ctx, userID, "chats", 0)
	return n, nil
}

// notifyUser tells one user's open apps that something of theirs changed.
func (s *Service) notifyUser(ctx context.Context, userID int64, typ string, convID int64) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		return notify(ctx, tx, event{Type: typ, ConversationID: convID, UserIDs: []int64{userID}})
	})
}

// wakeSnoozed brings back chats whose snooze time has come: to the top of Home, with the
// newest email unread again (Gmail's snooze). Returns how many came back.
func (s *Service) wakeSnoozed(ctx context.Context) (int, error) {
	var n int
	err := s.tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			UPDATE user_conversations SET snoozed_until = NULL, hidden = false, last_message_at = now()
			WHERE (user_id, conversation_id) IN (
				SELECT user_id, conversation_id FROM user_conversations
				WHERE snoozed_until <= now() ORDER BY user_id, conversation_id LIMIT 500 FOR UPDATE SKIP LOCKED)
			RETURNING user_id, conversation_id`)
		if err != nil {
			return err
		}
		type uc struct{ user, conv int64 }
		woke, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (uc, error) {
			var p uc
			return p, r.Scan(&p.user, &p.conv)
		})
		if err != nil {
			return err
		}
		n = len(woke)
		for _, w := range woke {
			if _, err := tx.Exec(ctx, `UPDATE mailbox mb SET is_read = false
				FROM user_conversations uc
				WHERE uc.user_id = $1 AND uc.conversation_id = $2
				  AND mb.user_id = uc.user_id AND mb.conversation_id = uc.conversation_id
				  AND mb.message_id = uc.last_message_id AND mb.folder = 'inbox'`, w.user, w.conv); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE user_conversations uc SET unread_count = (
				SELECT count(*) FROM mailbox mb WHERE mb.user_id = $1 AND mb.conversation_id = $2
				AND mb.folder = 'inbox' AND NOT mb.is_read) WHERE uc.user_id = $1 AND uc.conversation_id = $2`, w.user, w.conv); err != nil {
				return err
			}
			if err := notify(ctx, tx, event{Type: "chats", ConversationID: w.conv, UserIDs: []int64{w.user}}); err != nil {
				return err
			}
		}
		return nil
	})
	return n, err
}
