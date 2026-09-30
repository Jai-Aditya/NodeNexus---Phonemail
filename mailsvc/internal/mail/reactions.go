package mail

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Reactions are WhatsApp's six. A fixed set keeps them meaningful and small, and stops
// reactions being used as a second, unmoderated way to send text.
var ReactionEmoji = []string{"👍", "❤️", "😂", "😮", "😢", "🙏"}

func allowedReaction(e string) bool {
	for _, a := range ReactionEmoji {
		if a == e {
			return true
		}
	}
	return false
}

// React sets the user's reaction on a message they have, or removes it (emoji ""). One
// reaction per person per message; choosing another replaces it. Everyone who has the
// message sees it live, but reactions never send a push or SMS alert. People who were
// Bcc'd can't react: a reaction would tell everyone they got the email (Gmail's rule too).
func (s *Service) React(ctx context.Context, userID, msgID int64, emoji string) error {
	if emoji != "" && !allowedReaction(emoji) {
		return errBadRequest("That reaction isn't available.")
	}
	return s.tx(ctx, func(tx pgx.Tx) error {
		var has, bcc bool
		err := tx.QueryRow(ctx, `SELECT
			EXISTS (SELECT 1 FROM mailbox WHERE user_id = $1 AND message_id = $2 AND folder <> 'trash'),
			EXISTS (SELECT 1 FROM message_recipients WHERE message_id = $2 AND kind = 'bcc' AND user_id = $1)`,
			userID, msgID).Scan(&has, &bcc)
		if err != nil {
			return err
		}
		if !has {
			return errNotFound("Message not found.")
		}
		if bcc && emoji != "" {
			return ErrBlockedReaction
		}
		if emoji == "" {
			_, err = tx.Exec(ctx, `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2`, msgID, userID)
		} else {
			_, err = tx.Exec(ctx, `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
				ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`, msgID, userID, emoji)
		}
		if err != nil {
			return err
		}
		// Live update for everyone else who has the message, and the user's other devices.
		rows, err := tx.Query(ctx, `SELECT DISTINCT user_id FROM mailbox WHERE message_id = $1 AND user_id <> $2`, msgID, userID)
		if err != nil {
			return err
		}
		others, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return err
		}
		return notify(ctx, tx, event{Type: "reaction", MessageID: msgID, SenderID: userID, UserIDs: others})
	})
}

// fillReactions adds each message's reactions, grouped by emoji in the order first used.
func (s *Service) fillReactions(ctx context.Context, viewerID int64, ids []int64, index map[int64][]int, msgs []MessageView) error {
	rows, err := s.DB.Query(ctx, `SELECT r.message_id, r.emoji, r.user_id, u.display_name, u.addr_key
		FROM message_reactions r JOIN users u ON u.id = r.user_id
		WHERE r.message_id = ANY($1) ORDER BY r.message_id, r.created_at`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	type key struct {
		msg   int64
		emoji string
	}
	grouped := map[int64][]Reaction{}
	pos := map[key]int{}
	for rows.Next() {
		var msgID, uid int64
		var emoji, name, local string
		if err := rows.Scan(&msgID, &emoji, &uid, &name, &local); err != nil {
			return err
		}
		if name == "" {
			name = s.AddressOf(local)
		}
		k := key{msgID, emoji}
		i, ok := pos[k]
		if !ok {
			i = len(grouped[msgID])
			pos[k] = i
			grouped[msgID] = append(grouped[msgID], Reaction{Emoji: emoji, Names: []string{}})
		}
		r := &grouped[msgID][i]
		r.Count++
		if uid == viewerID {
			r.Mine = true
			r.Names = append([]string{"You"}, r.Names...)
		} else {
			r.Names = append(r.Names, name)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for msgID, rs := range grouped {
		for _, i := range index[msgID] {
			msgs[i].Reactions = rs
		}
	}
	return nil
}
