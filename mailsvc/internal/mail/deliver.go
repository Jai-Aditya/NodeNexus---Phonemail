package mail

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// target is a resolved recipient: a person or a group.
type target struct {
	kind    string // to, cc, bcc
	userID  int64
	groupID int64
}

// chat is one conversation a message is delivered into, with who gets a pointer.
type chat struct {
	id      int64
	members []int64 // includes the sender
	direct  bool
	spam    []int64 // members who blocked the sender: it goes to their Spam, quietly
	outside []int64 // members outside PhoneMail: no pointers or alerts; they get it by email
}

// Send delivers a new message: a new thread root (spec 6.1).
func (s *Service) Send(ctx context.Context, senderID int64, req SendRequest) (SendResult, error) {
	var res SendResult
	if req.ConversationID != nil {
		// New email inside a chat: To is the chat's other person, or the group itself.
		to, err := s.lockedRecipient(ctx, senderID, *req.ConversationID)
		if err != nil {
			return res, err
		}
		req.Recipients = Recipients{To: ToList{to}}
	}
	if len(req.To) == 0 {
		return res, errBadRequest("A message needs a To recipient.")
	}
	if n, max := len(req.To)+len(req.Cc)+len(req.Bcc), s.limits().MaxRecipients; n > max {
		return res, errBadRequest("A message can have at most %d recipients (To, Cc and Bcc together).", max)
	}
	if err := cleanContent(&req.Subject, &req.BodyText, &req.BodyHTML); err != nil {
		return res, err
	}
	if req.GroupName != "" && len(req.To) < 2 {
		return res, errBadRequest("group_name is only used when To has two or more people.")
	}
	if strings.TrimSpace(req.BodyText) == "" && strings.TrimSpace(req.BodyHTML) == "" &&
		strings.TrimSpace(req.Subject) == "" && req.DraftID == nil && req.ForwardedFromID == nil {
		return res, errBadRequest("The message is empty.")
	}
	err := s.tx(ctx, func(tx pgx.Tx) error {
		recips := req.Recipients
		if len(recips.To) > 1 {
			// Two or more people in To: the message goes to their group chat (spec keeps one To).
			to, err := s.groupForPeople(ctx, tx, senderID, recips.To, recips.GroupName)
			if err != nil {
				return err
			}
			recips.To = ToList{to}
		}
		targets, err := s.resolveRecipients(ctx, tx, senderID, recips)
		if err != nil {
			return err
		}

		// Attachments come from the draft being sent, or are copied from a forwarded message.
		attCount := 0
		if req.DraftID != nil {
			if attCount, err = lockDraft(ctx, tx, senderID, *req.DraftID, req.scheduled); err != nil {
				return err
			}
		}
		if req.ForwardedFromID != nil {
			n, err := s.forwardableAttachments(ctx, tx, senderID, *req.ForwardedFromID)
			if err != nil {
				return err
			}
			attCount += n
		}

		msgID, sentAt, err := s.insertMessage(ctx, tx, newMessage{
			SenderID: senderID, Subject: strings.TrimSpace(req.Subject),
			BodyText: req.BodyText, BodyHTML: req.BodyHTML,
			ForwardedFromID: req.ForwardedFromID, HasAttachments: attCount > 0,
		})
		if err != nil {
			return err
		}
		if err := insertRecipients(ctx, tx, msgID, targets); err != nil {
			return err
		}
		if req.DraftID != nil {
			if err := consumeDraft(ctx, tx, *req.DraftID, msgID); err != nil {
				return err
			}
		}
		if req.ForwardedFromID != nil {
			if _, err := tx.Exec(ctx, `INSERT INTO attachments
				(message_id, filename, content_type, size_bytes, sha256, storage_path)
				SELECT $1, filename, content_type, size_bytes, sha256, storage_path
				FROM attachments WHERE message_id = $2`, msgID, *req.ForwardedFromID); err != nil {
				return err
			}
		}

		// Work out the chats: each person -> the direct chat with the sender,
		// each group -> the group chat. The same chat is delivered to once.
		var chats []chat
		seen := map[int64]bool{}
		for _, t := range targets {
			var c chat
			if t.groupID != 0 {
				members, err := currentMembers(ctx, tx, t.groupID, nil)
				if err != nil {
					return err
				}
				c = chat{id: t.groupID, members: members}
			} else {
				id, err := findOrCreateDirect(ctx, tx, senderID, t.userID)
				if err != nil {
					return err
				}
				c = chat{id: id, members: []int64{senderID, t.userID}, direct: true}
			}
			if !seen[c.id] {
				seen[c.id] = true
				chats = append(chats, c)
			}
		}

		// Deliver in chat-id order, again so concurrent sends lock rows in the same order.
		sort.Slice(chats, func(i, j int) bool { return chats[i].id < chats[j].id })
		snippet := Snippet(firstNonEmpty(req.BodyText, stripTags(req.BodyHTML), req.Subject))
		for _, c := range chats {
			if err := prepareChat(ctx, tx, &c, senderID); err != nil {
				return err
			}
			if err := s.deliverToChat(ctx, tx, c, msgID, senderID, snippet, sentAt, attCount > 0); err != nil {
				return err
			}
			if err := s.notifyMessage(ctx, tx, c, msgID, senderID, req.Subject); err != nil {
				return err
			}
			res.Conversations = append(res.Conversations, c.id)
		}
		res.MessageID = msgID
		if req.dryRun {
			return errDryRun
		}
		return nil
	})
	if errors.Is(err, errDryRun) {
		return SendResult{}, nil
	}
	return res, err
}

// Reply answers a message inside the chat it was seen in (spec 6.2).
func (s *Service) Reply(ctx context.Context, senderID, parentID int64, req ReplyRequest) (SendResult, error) {
	var res SendResult
	if req.ConversationID == 0 {
		return res, errBadRequest("conversation_id is required.")
	}
	var noSubject string // replies take their subject from the parent
	if err := cleanContent(&noSubject, &req.BodyText, &req.BodyHTML); err != nil {
		return res, err
	}
	if strings.TrimSpace(req.BodyText) == "" && strings.TrimSpace(req.BodyHTML) == "" && req.DraftID == nil {
		return res, errBadRequest("The reply is empty.")
	}
	err := s.tx(ctx, func(tx pgx.Tx) error {
		// The sender must be able to see the parent in this chat.
		var (
			rootID, depth       int64
			path, subject, kind string
			rootSentAt          time.Time
		)
		err := tx.QueryRow(ctx, `
			SELECT m.root_id, m.path::text, m.depth, m.subject, c.kind, r.sent_at
			FROM mailbox mb
			JOIN messages m      ON m.id = mb.message_id
			JOIN messages r      ON r.id = m.root_id
			JOIN conversations c ON c.id = mb.conversation_id
			WHERE mb.user_id = $1 AND mb.message_id = $2 AND mb.conversation_id = $3`,
			senderID, parentID, req.ConversationID).Scan(&rootID, &path, &depth, &subject, &kind, &rootSentAt)
		if err == pgx.ErrNoRows {
			return errNotFound("Message not found in this chat.")
		}
		if err != nil {
			return err
		}

		// Recipients are locked to the chat.
		var to target
		var members []int64
		if kind == "direct" {
			var other int64
			err := tx.QueryRow(ctx, `SELECT user_id FROM conversation_participants
				WHERE conversation_id = $1 AND user_id <> $2`, req.ConversationID, senderID).Scan(&other)
			if err == pgx.ErrNoRows {
				return ErrAccountDeleted
			}
			if err != nil {
				return err
			}
			to = target{kind: "to", userID: other}
			members = []int64{senderID, other}
		} else {
			ok, err := isCurrentMember(ctx, tx, req.ConversationID, senderID)
			if err != nil {
				return err
			}
			if !ok {
				return errForbidden("You're no longer a member of this group.")
			}
			to = target{kind: "to", groupID: req.ConversationID}
			// Only members who joined before the thread started receive replies.
			if members, err = currentMembers(ctx, tx, req.ConversationID, &rootSentAt); err != nil {
				return err
			}
			if !containsID(members, senderID) {
				members = append(members, senderID)
			}
		}

		attCount := 0
		if req.DraftID != nil {
			if attCount, err = lockDraft(ctx, tx, senderID, *req.DraftID, req.scheduled); err != nil {
				return err
			}
		}

		pid := parentID
		msgID, sentAt, err := s.insertMessage(ctx, tx, newMessage{
			SenderID: senderID, Subject: replySubject(subject),
			BodyText: req.BodyText, BodyHTML: req.BodyHTML,
			ParentID: &pid, RootID: rootID, ParentPath: path, ParentDepth: int(depth),
			HasAttachments: attCount > 0,
		})
		if uniqueViolation(err, "messages_reply_once") {
			return ErrAlreadyReplied
		}
		if err != nil {
			return err
		}
		if err := insertRecipients(ctx, tx, msgID, []target{to}); err != nil {
			return err
		}
		if req.DraftID != nil {
			if err := consumeDraft(ctx, tx, *req.DraftID, msgID); err != nil {
				return err
			}
		}

		c := chat{id: req.ConversationID, members: members, direct: kind == "direct"}
		if err := prepareChat(ctx, tx, &c, senderID); err != nil {
			return err
		}
		snippet := Snippet(firstNonEmpty(req.BodyText, stripTags(req.BodyHTML)))
		if err := s.deliverToChat(ctx, tx, c, msgID, senderID, snippet, sentAt, attCount > 0); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE mailbox SET is_replied = true
			WHERE user_id = $1 AND message_id = $2 AND conversation_id = $3`,
			senderID, parentID, req.ConversationID); err != nil {
			return err
		}
		if err := s.notifyMessage(ctx, tx, c, msgID, senderID, replySubject(subject)); err != nil {
			return err
		}
		res = SendResult{MessageID: msgID, Conversations: []int64{c.id}}
		if req.dryRun {
			return errDryRun
		}
		return nil
	})
	if errors.Is(err, errDryRun) {
		return SendResult{}, nil
	}
	return res, err
}

// resolveRecipients validates To/Cc/Bcc and resolves them to users and groups.
func (s *Service) resolveRecipients(ctx context.Context, tx pgx.Tx, senderID int64, r Recipients) ([]target, error) {
	type item struct {
		kind string
		r    Recipient
	}
	if len(r.To) != 1 {
		return nil, errBadRequest("A message needs exactly one To recipient.")
	}
	items := []item{{"to", r.To[0]}}
	for _, c := range r.Cc {
		items = append(items, item{"cc", c})
	}
	for _, b := range r.Bcc {
		items = append(items, item{"bcc", b})
	}

	var out []target
	seen := map[target]bool{}
	for _, it := range items {
		hasAddr, hasGroup, hasName := strings.TrimSpace(it.r.Address) != "", it.r.GroupID != 0, strings.TrimSpace(it.r.Group) != ""
		if n := btoi(hasAddr) + btoi(hasGroup) + btoi(hasName); n != 1 {
			return nil, errBadRequest("Each recipient needs exactly one of address, group_id or group.")
		}
		t := target{kind: it.kind}
		var personID int64
		if hasName {
			gid, err := s.groupByName(ctx, tx, senderID, it.r.Group)
			if err != nil {
				return nil, err
			}
			it.r.GroupID, hasGroup = gid, true
		} else if hasAddr {
			uid, err := s.resolveRecipient(ctx, tx, it.r.Address)
			var notFound *Error
			if errors.As(err, &notFound) && notFound.Code == "not_found" && !strings.Contains(it.r.Address, "@") {
				// Not a person: maybe the name of one of the sender's groups.
				if gid, gerr := s.groupByName(ctx, tx, senderID, it.r.Address); gerr == nil {
					it.r.GroupID, hasGroup, err = gid, true, nil
				} else if ge, ok := gerr.(*Error); !ok || ge.Code != "not_found" {
					return nil, gerr
				}
			}
			if err != nil {
				return nil, err
			}
			personID = uid
		}
		if hasGroup {
			var kind string
			err := tx.QueryRow(ctx, `SELECT kind FROM conversations WHERE id = $1`, it.r.GroupID).Scan(&kind)
			if err == pgx.ErrNoRows || (err == nil && kind != "group") {
				return nil, errNotFound("Group %d not found.", it.r.GroupID)
			}
			if err != nil {
				return nil, err
			}
			ok, err := isCurrentMember(ctx, tx, it.r.GroupID, senderID)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, errForbidden("You can only send to groups you're a member of.")
			}
			t.groupID = it.r.GroupID
		} else {
			if personID == senderID {
				return nil, errBadRequest("You can't send an email to yourself.")
			}
			t.userID = personID
		}
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out, nil
}

// groupByName finds one of the sender's current groups by name, ignoring letter case.
// Other people's groups are never matched, so names only need to be unique per person.
func (s *Service) groupByName(ctx context.Context, tx pgx.Tx, senderID int64, name string) (int64, error) {
	name = strings.Join(strings.Fields(name), " ")
	rows, err := tx.Query(ctx, `SELECT c.id FROM conversations c
		JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = $1 AND p.left_at IS NULL
		WHERE c.kind = 'group' AND lower(c.name) = lower($2)
		ORDER BY c.id LIMIT 2`, senderID, name)
	if err != nil {
		return 0, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return 0, err
	}
	switch len(ids) {
	case 0:
		return 0, errNotFound("You're not in a group called %q.", name)
	case 1:
		return ids[0], nil
	}
	// Possible when someone else added you to a group with the same name as one of yours.
	return 0, errConflict("ambiguous_group",
		"You're in more than one group called %q. Choose which one you mean.", name)
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

type newMessage struct {
	SenderID                    int64
	Subject, BodyText, BodyHTML string
	ParentID                    *int64
	RootID                      int64 // 0 = this message is a thread root
	ParentPath                  string
	ParentDepth                 int
	ForwardedFromID             *int64
	HasAttachments              bool
	MessageIDHeader             string // an incoming email keeps its own; empty = make one
}

// insertMessage stores a message once, with its thread position.
func (s *Service) insertMessage(ctx context.Context, tx pgx.Tx, m newMessage) (int64, time.Time, error) {
	var id int64
	if err := tx.QueryRow(ctx, `SELECT nextval(pg_get_serial_sequence('messages', 'id'))`).Scan(&id); err != nil {
		return 0, time.Time{}, err
	}
	rootID, path, depth := id, idLabel(id), 0
	if m.ParentID != nil {
		rootID, path, depth = m.RootID, m.ParentPath+"."+idLabel(id), m.ParentDepth+1
	}
	snippet := Snippet(firstNonEmpty(m.BodyText, stripTags(m.BodyHTML), m.Subject))
	header := m.MessageIDHeader
	if header == "" {
		header = s.newMessageIDHeader(id)
	}
	var sentAt time.Time
	err := tx.QueryRow(ctx, `
		INSERT INTO messages (id, sender_id, subject, body_text, body_html, snippet,
			parent_id, root_id, path, depth, forwarded_from_id, has_attachments, message_id_header)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::ltree, $10, $11, $12, $13)
		RETURNING sent_at`,
		id, m.SenderID, m.Subject, m.BodyText, m.BodyHTML, snippet,
		m.ParentID, rootID, path, depth, m.ForwardedFromID, m.HasAttachments, header,
	).Scan(&sentAt)
	return id, sentAt, err
}

func insertRecipients(ctx context.Context, tx pgx.Tx, msgID int64, targets []target) error {
	for _, t := range targets {
		var uid, gid *int64
		if t.groupID != 0 {
			gid = &t.groupID
		} else {
			uid = &t.userID
		}
		if _, err := tx.Exec(ctx, `INSERT INTO message_recipients (message_id, kind, user_id, group_id)
			VALUES ($1, $2, $3, $4)`, msgID, t.kind, uid, gid); err != nil {
			return err
		}
	}
	return nil
}

// deliverToChat gives every member a pointer and updates their Home row (spec 6.1 step 4).
func (s *Service) deliverToChat(ctx context.Context, tx pgx.Tx, c chat, msgID, senderID int64,
	snippet string, sentAt time.Time, hasAtt bool) error {
	// Always lock rows in user-id order, so concurrent deliveries can't deadlock. People
	// outside PhoneMail have no mailbox here: they get the message as an email.
	var members []int64
	for _, m := range c.members {
		if !containsID(c.outside, m) {
			members = append(members, m)
		}
	}
	sort.Slice(members, func(i, j int) bool { return members[i] < members[j] })
	c.members = members
	spam := c.spam
	if spam == nil {
		spam = []int64{}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO mailbox (user_id, message_id, conversation_id, is_read, is_mine, received_at, folder)
		SELECT u, $2, $3, u = $4, u = $4, $5, CASE WHEN u = ANY($6) THEN 'spam' ELSE 'inbox' END
		FROM unnest($1::bigint[]) AS u ORDER BY u
		ON CONFLICT DO NOTHING`, c.members, msgID, c.id, senderID, sentAt, spam); err != nil {
		return err
	}
	// Home rows: not for people who get it in Spam (a blocked sender doesn't bring the
	// chat back up). New mail also ends an archive or a snooze.
	var home []int64
	for _, m := range c.members {
		if !containsID(spam, m) {
			home = append(home, m)
		}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO user_conversations AS uc
			(user_id, conversation_id, last_message_at, last_message_id, snippet, unread_count, has_attachments)
		SELECT u, $2, $3, $4, $5, CASE WHEN u = $6 THEN 0 ELSE 1 END, $7
		FROM unnest($1::bigint[]) AS u ORDER BY u
		ON CONFLICT (user_id, conversation_id) DO UPDATE SET
			last_message_at = EXCLUDED.last_message_at,
			last_message_id = EXCLUDED.last_message_id,
			snippet         = EXCLUDED.snippet,
			unread_count    = uc.unread_count + EXCLUDED.unread_count,
			has_attachments = uc.has_attachments OR EXCLUDED.has_attachments,
			hidden          = false,
			snoozed_until   = NULL`,
		home, c.id, sentAt, msgID, snippet, senderID, hasAtt)
	return err
}

func (s *Service) notifyMessage(ctx context.Context, tx pgx.Tx, c chat, msgID, senderID int64, subject string) error {
	var local string
	if err := tx.QueryRow(ctx, `SELECT addr_key FROM users WHERE id = $1`, senderID).Scan(&local); err != nil {
		return err
	}
	var others []int64 // everyone but the sender, those who blocked them, and outsiders
	emailOut := false
	for _, m := range c.members {
		if containsID(c.outside, m) {
			emailOut = emailOut || m != senderID
			continue
		}
		if m != senderID && !containsID(c.spam, m) {
			others = append(others, m)
		}
	}
	if emailOut {
		if err := queueOutside(ctx, tx, msgID); err != nil {
			return err
		}
	}
	if len(others) == 0 {
		return notify(ctx, tx, event{Type: "message", MessageID: msgID, ConversationID: c.id, SenderID: senderID, UserIDs: []int64{}})
	}
	// Who muted this chat: they get the mail (and the live update) but no alert.
	rows, err := tx.Query(ctx, `SELECT user_id FROM user_conversations
		WHERE conversation_id = $1 AND user_id = ANY($2) AND muted`, c.id, others)
	if err != nil {
		return err
	}
	muted, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return err
	}
	var alert []int64
	for _, m := range others {
		if !containsID(muted, m) {
			alert = append(alert, m)
		}
	}
	// Queue each recipient's alert (push or SMS) in this same transaction: if the mail is
	// delivered, its alerts exist; the API sends them and retries until they go out.
	if len(alert) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO alert_queue (user_id, conversation_id, message_id, sender_id, subject)
			SELECT u, $2, $3, $4, $5 FROM unnest($1::bigint[]) AS u`, alert, c.id, msgID, senderID, subject); err != nil {
			return err
		}
	}
	return notify(ctx, tx, event{Type: "message", MessageID: msgID, ConversationID: c.id,
		SenderID: senderID, SenderAddress: s.AddressOf(local), Subject: subject, UserIDs: others, Muted: muted})
}

// prepareChat notes which members blocked the sender and which are outside PhoneMail.
func prepareChat(ctx context.Context, tx pgx.Tx, c *chat, senderID int64) error {
	var err error
	if c.spam, err = blockedBy(ctx, tx, *c, senderID); err != nil {
		return err
	}
	if c.direct {
		c.outside, err = outsiders(ctx, tx, c.members)
	}
	return err
}

// blockedBy lists the members of a direct chat who blocked the sender. Group mail is
// never affected: blocking is about who may write to you directly.
func blockedBy(ctx context.Context, tx pgx.Tx, c chat, senderID int64) ([]int64, error) {
	if !c.direct {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM blocks WHERE blocked_id = $1 AND user_id = ANY($2)`, senderID, c.members)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[int64])
}

// findOrCreateDirect returns the one direct chat between two people, creating it if needed.
func findOrCreateDirect(ctx context.Context, tx pgx.Tx, a, b int64) (int64, error) {
	hash := ParticipantHash([]int64{a, b})
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO conversations (kind, participant_hash, created_by) VALUES ('direct', $1, $2)
		ON CONFLICT (participant_hash) WHERE kind = 'direct' DO NOTHING
		RETURNING id`, hash, a).Scan(&id)
	if err == pgx.ErrNoRows {
		err = tx.QueryRow(ctx, `SELECT id FROM conversations WHERE kind = 'direct' AND participant_hash = $1`, hash).Scan(&id)
		return id, err
	}
	if err != nil {
		return 0, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO conversation_participants (conversation_id, user_id)
		VALUES ($1, $2), ($1, $3)`, id, a, b)
	return id, err
}

// currentMembers lists a group's current members; with joinedBefore set, only
// those who joined before that time (the thread-visibility rule, spec 3).
func currentMembers(ctx context.Context, tx pgx.Tx, convID int64, joinedBefore *time.Time) ([]int64, error) {
	rows, err := tx.Query(ctx, `SELECT user_id FROM conversation_participants
		WHERE conversation_id = $1 AND left_at IS NULL AND ($2::timestamptz IS NULL OR joined_at < $2)
		ORDER BY user_id`, convID, joinedBefore)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[int64])
}

func replySubject(s string) string {
	s = strings.TrimSpace(s)
	for {
		l := strings.ToLower(s)
		if strings.HasPrefix(l, "re:") {
			s = strings.TrimSpace(s[3:])
			continue
		}
		break
	}
	if s == "" {
		return "Re:"
	}
	return "Re: " + s
}

// idLabel is a message id as an ltree label, zero-padded so paths sort in id order.
func idLabel(id int64) string { return fmt.Sprintf("%019d", id) }

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func containsID(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// lockedRecipient is the fixed To of a chat: the other person, or the group.
func (s *Service) lockedRecipient(ctx context.Context, userID, convID int64) (Recipient, error) {
	var kind string
	err := s.DB.QueryRow(ctx, `SELECT c.kind FROM conversations c
		JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = $2
		WHERE c.id = $1`, convID, userID).Scan(&kind)
	if err == pgx.ErrNoRows {
		return Recipient{}, errNotFound("Chat not found.")
	}
	if err != nil {
		return Recipient{}, err
	}
	if kind == "group" {
		return Recipient{GroupID: convID}, nil
	}
	var local string
	err = s.DB.QueryRow(ctx, `SELECT u.addr_key FROM conversation_participants p JOIN users u ON u.id = p.user_id
		WHERE p.conversation_id = $1 AND p.user_id <> $2`, convID, userID).Scan(&local)
	if err == pgx.ErrNoRows {
		return Recipient{}, ErrAccountDeleted
	}
	return Recipient{Address: s.AddressOf(local)}, err
}
