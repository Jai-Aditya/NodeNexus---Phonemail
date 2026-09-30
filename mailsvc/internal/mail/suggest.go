package mail

import (
	"context"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// numberish: only digits, spaces, "+", "-" and brackets, i.e. a phone number being typed.
var numberish = regexp.MustCompile(`^[0-9+\-() ]+$`)

// Suggestion is a person offered while typing a recipient.
type Suggestion struct {
	Person
	ConversationID *int64 `json:"conversation_id,omitempty"` // your direct chat with them, if any
	// Known: you already share a conversation (a direct chat or a group). A person found only
	// by typing their exact number, address or alias is not known.
	Known bool `json:"known"`
}

// Suggestions are the people and groups matching what is typed in To, Cc or Bcc.
type Suggestions struct {
	People []Suggestion `json:"people"`
	Groups []Group      `json:"groups"`
}

// Suggest finds recipients for what the user is typing:
//  1. people the user shares a conversation with (a direct chat or any group, now or
//     before), matched by the start of a word in their name, the start of their number,
//     or the start of one of their aliases;
//  2. the user's current groups whose name contains the text (with their members, so
//     groups with the same name can be told apart);
//  3. anyone else on PhoneMail, but only by an exact number, address or alias. Matching
//     strangers by partial text would let anyone list every registered number and name,
//     so a stranger is found only by someone who already knows how to reach them.
func (s *Service) Suggest(ctx context.Context, userID int64, q string) (Suggestions, error) {
	res := Suggestions{People: []Suggestion{}, Groups: []Group{}}
	q = strings.TrimSpace(q)
	if q == "" {
		return res, nil
	}
	text := likeEscape.Replace(strings.ToLower(q))
	digits := "" // what's typed, if it's (the start of) a phone number
	if numberish.MatchString(q) {
		digits = nonDigit.ReplaceAllString(q, "")
	}
	if len(digits) > 10 {
		digits = digits[len(digits)-10:] // +91 98765 43210 -> the 10-digit mailbox part
	}

	rows, err := s.DB.Query(ctx, `
		WITH contacts AS (
			SELECT DISTINCT p2.user_id
			FROM conversation_participants p1
			JOIN conversation_participants p2 ON p2.conversation_id = p1.conversation_id AND p2.user_id <> p1.user_id
			WHERE p1.user_id = $1
		)
		SELECT u.id, u.addr_key, u.display_name, u.avatar_url, d.id
		FROM contacts ct
		JOIN users u ON u.id = ct.user_id
		LEFT JOIN LATERAL (
			SELECT c.id FROM conversations c
			JOIN conversation_participants a ON a.conversation_id = c.id AND a.user_id = $1
			JOIN conversation_participants b ON b.conversation_id = c.id AND b.user_id = u.id
			WHERE c.kind = 'direct' LIMIT 1
		) d ON true
		LEFT JOIN user_conversations uc ON uc.user_id = $1 AND uc.conversation_id = d.id
		WHERE lower(u.display_name) LIKE $2 || '%' OR lower(u.display_name) LIKE '% ' || $2 || '%'
		   OR ($3 <> '' AND u.phone_local LIKE $3 || '%')
		   OR EXISTS (SELECT 1 FROM aliases al WHERE al.user_id = u.id AND al.alias LIKE $2 || '%')
		ORDER BY uc.last_message_at DESC NULLS LAST, lower(u.display_name), u.id
		LIMIT 8`, userID, text, digits)
	if err != nil {
		return res, err
	}
	res.People, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Suggestion, error) {
		var p Suggestion
		var local string
		err := r.Scan(&p.UserID, &local, &p.DisplayName, &p.AvatarURL, &p.ConversationID)
		p.Address, p.Known = s.AddressOf(local), true
		return p, err
	})
	if err != nil {
		return res, err
	}

	grows, err := s.DB.Query(ctx, `SELECT c.id, c.name, c.created_at FROM conversations c
		JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = $1 AND p.left_at IS NULL
		WHERE c.kind = 'group' AND lower(c.name) LIKE '%' || $2 || '%'
		ORDER BY lower(c.name), c.id LIMIT 6`, userID, text)
	if err != nil {
		return res, err
	}
	res.Groups, err = pgx.CollectRows(grows, func(r pgx.CollectableRow) (Group, error) {
		var g Group
		return g, r.Scan(&g.ConversationID, &g.Name, &g.CreatedAt)
	})
	if err != nil {
		return res, err
	}
	if len(res.Groups) > 0 {
		ids := make([]int64, len(res.Groups))
		for i, g := range res.Groups {
			ids[i] = g.ConversationID
		}
		members, err := s.membersOf(ctx, ids)
		if err != nil {
			return res, err
		}
		for i := range res.Groups {
			res.Groups[i].Members = members[res.Groups[i].ConversationID]
		}
	}

	// Anyone else: an exact number, address or alias only.
	uid, err := s.resolveAddress(ctx, s.DB, q)
	if err != nil {
		return res, nil // not a PhoneMail user (or an outside address): nothing more to suggest
	}
	if uid == userID {
		return res, nil
	}
	for _, p := range res.People {
		if p.UserID == uid {
			return res, nil
		}
	}
	var p Suggestion
	var local string
	if err := s.DB.QueryRow(ctx, `SELECT id, addr_key, display_name, avatar_url FROM users WHERE id = $1`, uid).
		Scan(&p.UserID, &local, &p.DisplayName, &p.AvatarURL); err != nil {
		return res, err
	}
	p.Address = s.AddressOf(local)
	res.People = append(res.People, p)
	return res, nil
}
