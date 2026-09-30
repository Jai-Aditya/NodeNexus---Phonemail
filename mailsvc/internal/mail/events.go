package mail

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// ChatEvent is a group activity line: "Asha added Ravi", "Meena left", "Ravi is now an admin".
// Text is ready to show (from the viewer's side: "You added Ravi"); Kind, Actor and
// Target let a client write its own wording, e.g. in another language.
type ChatEvent struct {
	ID     int64     `json:"id"`
	Kind   string    `json:"kind"` // created, added, removed, left, admin, not_admin
	Actor  *Person   `json:"actor,omitempty"`
	Target *Person   `json:"target,omitempty"`
	Text   string    `json:"text"`
	At     time.Time `json:"at"`
}

// logGroupEvent records an activity line (target 0 = none; actor 0 = automatic) and
// tells the chat's current members, plus the target, so open chats can show it.
func logGroupEvent(ctx context.Context, tx pgx.Tx, convID int64, kind string, actorID, targetID int64) error {
	if _, err := tx.Exec(ctx, `INSERT INTO conversation_events (conversation_id, kind, actor_id, target_id)
		VALUES ($1, $2, NULLIF($3, 0), NULLIF($4, 0))`, convID, kind, actorID, targetID); err != nil {
		return err
	}
	if kind == "created" {
		return nil // group_created already tells the members
	}
	members, err := currentMembers(ctx, tx, convID, nil)
	if err != nil {
		return err
	}
	if targetID != 0 && !containsID(members, targetID) {
		members = append(members, targetID) // e.g. the person just removed
	}
	return notify(ctx, tx, event{Type: "group_event", ConversationID: convID, SenderID: actorID,
		Subject: kind, UserIDs: without(members, actorID)})
}

// ChatEvents lists the activity lines of a chat that the viewer may see: those from
// while they were a member (a new member doesn't see the group's earlier history,
// like its messages). after/until bound the time window (either may be nil):
// after is inclusive, until exclusive, so consecutive chat pages never overlap.
func (s *Service) ChatEvents(ctx context.Context, viewerID, convID int64, after, until *time.Time) ([]ChatEvent, error) {
	rows, err := s.DB.Query(ctx, `
		SELECT e.id, e.kind, e.created_at,
		       a.id, a.addr_key, a.display_name, a.avatar_url,
		       t.id, t.addr_key, t.display_name, t.avatar_url
		FROM conversation_events e
		JOIN conversation_participants p ON p.conversation_id = e.conversation_id AND p.user_id = $1
		LEFT JOIN users a ON a.id = e.actor_id
		LEFT JOIN users t ON t.id = e.target_id
		WHERE e.conversation_id = $2
		  AND e.created_at >= p.joined_at AND (p.left_at IS NULL OR e.created_at <= p.left_at)
		  AND ($3::timestamptz IS NULL OR e.created_at >= $3)
		  AND ($4::timestamptz IS NULL OR e.created_at < $4)
		ORDER BY e.created_at DESC, e.id DESC`, viewerID, convID, after, until)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (ChatEvent, error) {
		var e ChatEvent
		var aID, tID *int64
		var aLocal, aName, aAvatar, tLocal, tName, tAvatar *string
		err := r.Scan(&e.ID, &e.Kind, &e.At, &aID, &aLocal, &aName, &aAvatar, &tID, &tLocal, &tName, &tAvatar)
		e.Actor = s.optPerson(aID, aLocal, aName, aAvatar)
		e.Target = s.optPerson(tID, tLocal, tName, tAvatar)
		e.Text = eventText(e, viewerID)
		return e, err
	})
	if out == nil {
		out = []ChatEvent{}
	}
	return out, err
}

func (s *Service) optPerson(id *int64, local, name, avatar *string) *Person {
	if id == nil {
		return nil
	}
	return &Person{UserID: *id, Address: s.AddressOf(*local), DisplayName: *name, AvatarURL: *avatar}
}

// eventText words an activity line for one viewer: "You added Ravi", "Asha added you".
func eventText(e ChatEvent, viewerID int64) string {
	who := func(p *Person, subject bool) string {
		switch {
		case p == nil:
			return DeletedName
		case p.UserID == viewerID && subject:
			return "You"
		case p.UserID == viewerID:
			return "you"
		case p.DisplayName != "":
			return p.DisplayName
		}
		return p.Address
	}
	a, t := who(e.Actor, true), who(e.Target, false)
	tSubject := who(e.Target, true)
	switch e.Kind {
	case "created":
		return a + " created the group"
	case "added":
		return a + " added " + t
	case "removed":
		return a + " removed " + t
	case "left":
		return a + " left"
	case "admin":
		if e.Actor == nil {
			if tSubject == "You" {
				return "You're now an admin"
			}
			return tSubject + " is now an admin"
		}
		return a + " made " + t + " an admin"
	case "not_admin":
		if e.Actor == nil || (e.Target != nil && e.Actor.UserID == e.Target.UserID) {
			if tSubject == "You" {
				return "You're no longer an admin"
			}
			return tSubject + " is no longer an admin"
		}
		return a + " removed " + t + " as admin"
	}
	return ""
}
