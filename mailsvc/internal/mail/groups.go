package mail

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// CreateGroup is compose with Gcc + a name (spec 6.7). Reuses an existing group with
// exactly these members and this name; otherwise creates one with the creator as admin.
func (s *Service) CreateGroup(ctx context.Context, creatorID int64, name string, members []Recipient) (Group, error) {
	name, err := checkGroupName(name)
	if err != nil {
		return Group{}, err
	}
	if name == "" {
		return Group{}, errBadRequest("A group needs a name.")
	}
	var convID int64
	created := false
	err = s.tx(ctx, func(tx pgx.Tx) error {
		ids := []int64{creatorID}
		for _, m := range members {
			if m.GroupID != 0 || m.Group != "" || strings.TrimSpace(m.Address) == "" {
				return errBadRequest("Group members must be people (addresses or phone numbers).")
			}
			uid, err := s.resolveAddress(ctx, tx, m.Address)
			err = outsideGroup(err)
			if err != nil {
				return err
			}
			if !containsID(ids, uid) {
				ids = append(ids, uid)
			}
		}
		if len(ids) < 2 {
			return errBadRequest("Add at least one other person to the group.")
		}
		if max := s.limits().MaxGroupMembers; len(ids) > max {
			return errBadRequest("A group can have at most %d members.", max)
		}
		var err error
		convID, created, err = findOrCreateGroup(ctx, tx, creatorID, name, ids)
		return err
	})
	if err != nil {
		return Group{}, err
	}
	g, err := s.GetGroup(ctx, creatorID, convID)
	g.Created = created
	return g, err
}

// findOrCreateGroup returns the group with exactly these members (ids includes the
// creator) and this name, creating it with the creator as admin if there is none.
func findOrCreateGroup(ctx context.Context, tx pgx.Tx, creatorID int64, name string, ids []int64) (int64, bool, error) {
	hash := ParticipantHash(ids)
	var convID int64
	err := tx.QueryRow(ctx, `SELECT id FROM conversations
		WHERE kind = 'group' AND participant_hash = $1 AND name = $2`, hash, name).Scan(&convID)
	if err == nil {
		return convID, false, nil // same members, same name: reuse it
	}
	if err != pgx.ErrNoRows {
		return 0, false, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO conversations (kind, name, participant_hash, created_by)
		VALUES ('group', $1, $2, $3)
		ON CONFLICT (participant_hash, name) WHERE kind = 'group' DO NOTHING
		RETURNING id`, name, hash, creatorID).Scan(&convID)
	if err == pgx.ErrNoRows {
		// Created by a concurrent request a moment ago: reuse it.
		err = tx.QueryRow(ctx, `SELECT id FROM conversations
			WHERE kind = 'group' AND participant_hash = $1 AND name = $2`, hash, name).Scan(&convID)
		return convID, false, err
	}
	if err != nil {
		return 0, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO conversation_participants (conversation_id, user_id, role)
		SELECT $1, u, CASE WHEN u = $2 THEN 'admin' ELSE 'member' END FROM unnest($3::bigint[]) AS u`,
		convID, creatorID, ids); err != nil {
		return 0, false, err
	}
	if err := addHomeRows(ctx, tx, convID, ids); err != nil {
		return 0, false, err
	}
	if err := logGroupEvent(ctx, tx, convID, "created", creatorID, 0); err != nil {
		return 0, false, err
	}
	err = notify(ctx, tx, event{Type: "group_created", ConversationID: convID, SenderID: creatorID, UserIDs: without(ids, creatorID)})
	return convID, err == nil, err
}

// groupForPeople is the brief's Home rule: two or more people in To start a group.
// The group always needs a name (the client asks for one), because the same people
// may have several groups and only the name tells them apart. An existing group is
// never reached this way: it is addressed by its name (or id) in To, Cc or Bcc, so
// listing its members again with its name is refused with a pointer to it.
// The same person listed twice collapses to an ordinary one-to-one email.
func (s *Service) groupForPeople(ctx context.Context, tx pgx.Tx, senderID int64, people ToList, name string) (Recipient, error) {
	ids := []int64{senderID}
	var first Recipient
	for _, p := range people {
		if p.GroupID != 0 || p.Group != "" || strings.TrimSpace(p.Address) == "" {
			return Recipient{}, errBadRequest("To can hold one group, or one or more people, but not a group among people.")
		}
		uid, err := s.resolveAddress(ctx, tx, p.Address)
		err = outsideGroup(err)
		if err != nil {
			return Recipient{}, err
		}
		if uid == senderID {
			return Recipient{}, errBadRequest("You can't send an email to yourself.")
		}
		if !containsID(ids, uid) {
			if len(ids) == 1 {
				first = p
			}
			ids = append(ids, uid)
		}
	}
	if len(ids) == 2 {
		if strings.TrimSpace(name) != "" {
			return Recipient{}, errBadRequest("group_name is only used when To has two or more people.")
		}
		return first, nil
	}
	name, err := checkGroupName(name)
	if err != nil {
		return Recipient{}, err
	}
	if name == "" {
		return Recipient{}, ErrGroupNameNeeded
	}
	var existing int64
	err = tx.QueryRow(ctx, `SELECT id FROM conversations
		WHERE kind = 'group' AND participant_hash = $1 AND name = $2`, ParticipantHash(ids), name).Scan(&existing)
	if err == nil {
		return Recipient{}, errConflict("group_exists",
			"You already have the group %q with these people. Send to it by its name instead.", name)
	}
	if err != pgx.ErrNoRows {
		return Recipient{}, err
	}
	convID, _, err := findOrCreateGroup(ctx, tx, senderID, name, ids)
	return Recipient{GroupID: convID}, err
}

// checkGroupName trims a group name and checks its length ("" is returned as is).
func checkGroupName(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if utf8.RuneCountInString(name) > 100 {
		return "", errBadRequest("Group names can be at most 100 characters.")
	}
	return name, nil
}

// ListGroups lists the groups the user currently belongs to (for the compose picker).
func (s *Service) ListGroups(ctx context.Context, userID int64) ([]Group, error) {
	rows, err := s.DB.Query(ctx, `SELECT c.id, c.name, c.created_at FROM conversations c
		JOIN conversation_participants p ON p.conversation_id = c.id
		WHERE p.user_id = $1 AND p.left_at IS NULL AND c.kind = 'group'
		ORDER BY c.name, c.id`, userID)
	if err != nil {
		return nil, err
	}
	groups, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Group, error) {
		var g Group
		err := r.Scan(&g.ConversationID, &g.Name, &g.CreatedAt)
		return g, err
	})
	if err != nil {
		return nil, err
	}
	ids := make([]int64, len(groups))
	for i := range groups {
		ids[i] = groups[i].ConversationID
	}
	members, err := s.membersOf(ctx, ids) // one query for all groups
	if err != nil {
		return nil, err
	}
	for i := range groups {
		groups[i].Members = members[groups[i].ConversationID]
	}
	return groups, nil
}

// GetGroup shows a group to someone who is (or was) in it.
func (s *Service) GetGroup(ctx context.Context, userID, convID int64) (Group, error) {
	var g Group
	err := s.DB.QueryRow(ctx, `SELECT c.id, c.name, c.created_at FROM conversations c
		JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = $2
		WHERE c.id = $1 AND c.kind = 'group'`, convID, userID).Scan(&g.ConversationID, &g.Name, &g.CreatedAt)
	if err == pgx.ErrNoRows {
		return g, errNotFound("Group not found.")
	}
	if err != nil {
		return g, err
	}
	g.Members, err = s.groupMembers(ctx, convID)
	return g, err
}

func (s *Service) groupMembers(ctx context.Context, convID int64) ([]GroupMember, error) {
	m, err := s.membersOf(ctx, []int64{convID})
	return m[convID], err
}

// membersOf loads the current members of many groups in one query, keyed by group id.
func (s *Service) membersOf(ctx context.Context, convIDs []int64) (map[int64][]GroupMember, error) {
	out := make(map[int64][]GroupMember, len(convIDs))
	for _, id := range convIDs {
		out[id] = []GroupMember{} // an empty list, not null, for a group nobody is left in
	}
	rows, err := s.DB.Query(ctx, `SELECT p.conversation_id, u.id, u.addr_key, u.display_name, u.avatar_url, p.role, p.joined_at
		FROM conversation_participants p JOIN users u ON u.id = p.user_id
		WHERE p.conversation_id = ANY($1) AND p.left_at IS NULL
		ORDER BY p.conversation_id, p.role, p.joined_at, u.id`, convIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var conv int64
		var m GroupMember
		var local string
		if err := rows.Scan(&conv, &m.UserID, &local, &m.DisplayName, &m.AvatarURL, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		m.Address = s.AddressOf(local)
		out[conv] = append(out[conv], m)
	}
	return out, rows.Err()
}

// AddMembers (admins only): new members only see threads started after they join.
func (s *Service) AddMembers(ctx context.Context, adminID, convID int64, members []Recipient) (Group, error) {
	err := s.tx(ctx, func(tx pgx.Tx) error {
		name, err := lockGroupAsAdmin(ctx, tx, convID, adminID)
		if err != nil {
			return err
		}
		var added []int64
		for _, m := range members {
			if m.GroupID != 0 || strings.TrimSpace(m.Address) == "" {
				return errBadRequest("Group members must be people (addresses or phone numbers).")
			}
			uid, err := s.resolveAddress(ctx, tx, m.Address)
			err = outsideGroup(err)
			if err != nil {
				return err
			}
			tag, err := tx.Exec(ctx, `INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
				VALUES ($1, $2, 'member', now())
				ON CONFLICT (conversation_id, user_id) DO UPDATE
					SET role = 'member', joined_at = now(), left_at = NULL
					WHERE conversation_participants.left_at IS NOT NULL`, convID, uid)
			if err != nil {
				return err
			}
			if tag.RowsAffected() > 0 && !containsID(added, uid) {
				added = append(added, uid)
			}
		}
		if len(added) == 0 {
			return nil // everyone was already a member
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM conversation_participants
			WHERE conversation_id = $1 AND left_at IS NULL`, convID).Scan(&count); err != nil {
			return err
		}
		if max := s.limits().MaxGroupMembers; count > max {
			return errBadRequest("A group can have at most %d members.", max)
		}
		if err := rehashGroup(ctx, tx, convID, name); err != nil {
			return err
		}
		if err := addHomeRows(ctx, tx, convID, added); err != nil {
			return err
		}
		for _, uid := range added {
			if err := logGroupEvent(ctx, tx, convID, "added", adminID, uid); err != nil {
				return err
			}
		}
		return notify(ctx, tx, event{Type: "group_members_added", ConversationID: convID, SenderID: adminID, UserIDs: added})
	})
	if err != nil {
		return Group{}, err
	}
	return s.GetGroup(ctx, adminID, convID)
}

// RemoveMember (admins only). The removed person keeps what they already received.
func (s *Service) RemoveMember(ctx context.Context, adminID, convID, userID int64) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		name, err := lockGroupAsAdmin(ctx, tx, convID, adminID)
		if err != nil {
			return err
		}
		return leave(ctx, tx, convID, userID, adminID, name)
	})
}

// LeaveGroup lets any member leave.
func (s *Service) LeaveGroup(ctx context.Context, userID, convID int64) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		name, err := lockGroup(ctx, tx, convID)
		if err != nil {
			return err
		}
		return leave(ctx, tx, convID, userID, userID, name)
	})
}

// SetRole (admins only) makes a member an admin or a plain member; at least one admin always remains.
func (s *Service) SetRole(ctx context.Context, adminID, convID, userID int64, role string) error {
	if role != "admin" && role != "member" {
		return errBadRequest("role must be \"admin\" or \"member\".")
	}
	return s.tx(ctx, func(tx pgx.Tx) error {
		if _, err := lockGroupAsAdmin(ctx, tx, convID, adminID); err != nil {
			return err
		}
		var current string
		err := tx.QueryRow(ctx, `SELECT role FROM conversation_participants
			WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, convID, userID).Scan(&current)
		if err == pgx.ErrNoRows {
			return errNotFound("That person isn't a member of this group.")
		}
		if err != nil {
			return err
		}
		if current == role {
			return nil // nothing changes, so no activity line either
		}
		if _, err := tx.Exec(ctx, `UPDATE conversation_participants SET role = $3
			WHERE conversation_id = $1 AND user_id = $2`, convID, userID, role); err != nil {
			return err
		}
		var admins int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM conversation_participants
			WHERE conversation_id = $1 AND left_at IS NULL AND role = 'admin'`, convID).Scan(&admins); err != nil {
			return err
		}
		if admins == 0 {
			return errConflict("last_admin", "A group needs at least one admin. Make someone else admin first.")
		}
		kind := "admin"
		if role == "member" {
			kind = "not_admin"
		}
		return logGroupEvent(ctx, tx, convID, kind, adminID, userID)
	})
}

// leave ends userID's membership: they left (actorID == userID) or an admin removed them.
func leave(ctx context.Context, tx pgx.Tx, convID, userID, actorID int64, name string, force ...bool) error {
	tag, err := tx.Exec(ctx, `UPDATE conversation_participants SET left_at = now(), role = 'member'
		WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, convID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound("That person isn't a member of this group.")
	}
	if err := rehashGroup(ctx, tx, convID, name, force...); err != nil {
		return err
	}
	if actorID == userID {
		err = logGroupEvent(ctx, tx, convID, "left", userID, 0)
	} else {
		err = logGroupEvent(ctx, tx, convID, "removed", actorID, userID)
	}
	if err != nil {
		return err
	}
	// Like WhatsApp: if no admin is left, the longest-standing member becomes admin.
	var promoted int64
	err = tx.QueryRow(ctx, `
		UPDATE conversation_participants SET role = 'admin'
		WHERE conversation_id = $1 AND user_id = (
			SELECT user_id FROM conversation_participants
			WHERE conversation_id = $1 AND left_at IS NULL
			ORDER BY joined_at, user_id LIMIT 1)
		AND NOT EXISTS (SELECT 1 FROM conversation_participants
			WHERE conversation_id = $1 AND left_at IS NULL AND role = 'admin')
		RETURNING user_id`, convID).Scan(&promoted)
	switch {
	case err == nil:
		if err := logGroupEvent(ctx, tx, convID, "admin", 0, promoted); err != nil {
			return err
		}
	case err != pgx.ErrNoRows:
		return err
	}
	return notify(ctx, tx, event{Type: "group_member_left", ConversationID: convID, SenderID: userID, UserIDs: []int64{userID}})
}

func lockGroup(ctx context.Context, tx pgx.Tx, convID int64) (string, error) {
	var kind string
	var name *string
	err := tx.QueryRow(ctx, `SELECT kind, name FROM conversations WHERE id = $1 FOR UPDATE`, convID).Scan(&kind, &name)
	if err == pgx.ErrNoRows || (err == nil && kind != "group") {
		return "", errNotFound("Group not found.")
	}
	if err != nil {
		return "", err
	}
	return *name, nil
}

func lockGroupAsAdmin(ctx context.Context, tx pgx.Tx, convID, adminID int64) (string, error) {
	name, err := lockGroup(ctx, tx, convID)
	if err != nil {
		return "", err
	}
	var role string
	err = tx.QueryRow(ctx, `SELECT role FROM conversation_participants
		WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, convID, adminID).Scan(&role)
	if err == pgx.ErrNoRows {
		return "", errNotFound("Group not found.")
	}
	if err != nil {
		return "", err
	}
	if role != "admin" {
		return "", errForbidden("Only group admins can do that.")
	}
	return name, nil
}

// rehashGroup recalculates the participant hash after membership changes.
// force (account deletion, which can't be refused): if the new member set and name clash
// with another group, the group gets a unique hash instead, so it simply stays separate.
func rehashGroup(ctx context.Context, tx pgx.Tx, convID int64, name string, force ...bool) error {
	members, err := currentMembers(ctx, tx, convID, nil)
	if err != nil {
		return err
	}
	hash := ParticipantHash(members)
	if len(members) == 0 {
		hash = "empty:" + idLabel(convID) // an empty group must never clash with another
	}
	if len(force) > 0 && force[0] {
		var clash bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversations
			WHERE kind = 'group' AND participant_hash = $1 AND name = $2 AND id <> $3)`, hash, name, convID).Scan(&clash); err != nil {
			return err
		}
		if clash {
			hash = "kept:" + idLabel(convID) + ":" + hash
		}
	}
	_, err = tx.Exec(ctx, `UPDATE conversations SET participant_hash = $2 WHERE id = $1`, convID, hash)
	if uniqueViolation(err, "conversations_group_uniq") {
		return ErrGroupClash
	}
	return err
}

// addHomeRows makes a chat appear on these users' Home screens.
func addHomeRows(ctx context.Context, tx pgx.Tx, convID int64, userIDs []int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO user_conversations (user_id, conversation_id, last_message_at)
		SELECT u, $1, $3 FROM unnest($2::bigint[]) AS u
		ON CONFLICT (user_id, conversation_id) DO UPDATE SET hidden = false`, convID, userIDs, time.Now())
	return err
}

func without(ids []int64, drop int64) []int64 {
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id != drop {
			out = append(out, id)
		}
	}
	return out
}
