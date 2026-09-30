package mail

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Home lists the user's chats, newest first (spec 6.3).
// filter: all, unread, attachments, favorites (chats in Home), archived, snoozed, or
// everything ("All mail": every chat with mail, archived and snoozed ones too).
func (s *Service) Home(ctx context.Context, userID int64, filter string, cur Cursor) ([]ChatSummary, error) {
	return s.home(ctx, userID, filter, cur, nil)
}

// Chat is one chat's Home row (for its header: muted, archived, snoozed), wherever it is.
func (s *Service) Chat(ctx context.Context, userID, convID int64) (ChatSummary, error) {
	list, err := s.home(ctx, userID, "one", Cursor{}, &convID)
	if err != nil {
		return ChatSummary{}, err
	}
	if len(list) == 0 {
		return ChatSummary{}, errNotFound("Chat not found.")
	}
	return list[0], nil
}

func (s *Service) home(ctx context.Context, userID int64, filter string, cur Cursor, only *int64) ([]ChatSummary, error) {
	const inHome = "AND NOT uc.hidden AND (uc.snoozed_until IS NULL OR uc.snoozed_until <= now()) "
	cond := map[string]string{
		"": inHome, "all": inHome,
		"unread":      inHome + "AND uc.unread_count > 0",
		"attachments": inHome + "AND uc.has_attachments",
		"favorites":   inHome + "AND uc.favourite_count > 0",
		"favourites":  inHome + "AND uc.favourite_count > 0",
		"archived":    "AND uc.hidden AND uc.last_message_id IS NOT NULL",
		"snoozed":     "AND uc.snoozed_until > now()",
		"everything":  "AND uc.last_message_id IS NOT NULL",
	}
	if only != nil {
		cond["one"] = ""
	}
	extra, ok := cond[filter]
	if !ok {
		return nil, errBadRequest("filter must be all, unread, attachments, favorites, archived, snoozed or everything.")
	}
	rows, err := s.DB.Query(ctx, `
		SELECT uc.conversation_id, c.kind, coalesce(c.name, ''), uc.last_message_at, uc.last_message_id,
		       uc.snippet, uc.unread_count, uc.has_attachments, uc.favourite_count,
		       uc.hidden, uc.muted, uc.snoozed_until,
		       peer.id, peer.addr_key, peer.display_name, peer.avatar_url,
		       CASE WHEN c.kind = 'group' THEN (SELECT count(*) FROM conversation_participants p2
		            WHERE p2.conversation_id = c.id AND p2.left_at IS NULL) ELSE 0 END
		FROM user_conversations uc
		JOIN conversations c ON c.id = uc.conversation_id
		LEFT JOIN LATERAL (
			SELECT u.id, u.addr_key, u.display_name, u.avatar_url
			FROM conversation_participants p JOIN users u ON u.id = p.user_id
			WHERE c.kind = 'direct' AND p.conversation_id = c.id AND p.user_id <> $1 LIMIT 1
		) peer ON true
		WHERE uc.user_id = $1 `+extra+`
		  AND ($2::timestamptz IS NULL OR (uc.last_message_at, uc.conversation_id) < ($2, $3))
		  AND ($5::bigint IS NULL OR uc.conversation_id = $5)
		ORDER BY uc.last_message_at DESC, uc.conversation_id DESC
		LIMIT $4`, userID, cur.Before, cur.BeforeID, cur.limit(), only)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ChatSummary, error) {
		var c ChatSummary
		var peerID *int64
		var peerLocal, peerName, peerAvatar *string
		err := r.Scan(&c.ConversationID, &c.Kind, &c.Name, &c.LastMessageAt, &c.LastMessageID,
			&c.Snippet, &c.UnreadCount, &c.HasAttachments, &c.FavouriteCount,
			&c.Archived, &c.Muted, &c.SnoozedUntil,
			&peerID, &peerLocal, &peerName, &peerAvatar, &c.MemberCount)
		if peerID != nil {
			c.Peer = &Person{UserID: *peerID, Address: s.AddressOf(*peerLocal), DisplayName: *peerName, AvatarURL: *peerAvatar}
		} else if c.Kind == "direct" {
			c.Name = DeletedName // the other person deleted their account; the chat stays readable
		}
		return c, err
	})
}

// PreviewChars is how much of a message lists (chat, thread, Spam/Trash, search) show.
// Longer messages come as a preview with Truncated set; the full text is opened with
// GET /messages/{id} (the brief's "tap long mail for a full view").
const PreviewChars = 100

// maxListHTML: formatted bodies up to this size are sent in lists (short messages keep
// their formatting); bigger ones only in the full view.
const maxListHTML = 4096

// messageCols is for lists: the database sends only the start of a long text body and
// no big HTML body, so long emails never travel whole just to be listed.
var messageCols = messageColsWith(fmt.Sprintf(
	`left(m.body_text, %d), CASE WHEN length(m.body_html) <= %d THEN m.body_html ELSE '' END,
	 length(m.body_text), length(m.body_html)`, PreviewChars+1, maxListHTML))

// fullMessageCols is for the single-message view: everything.
var fullMessageCols = messageColsWith(`m.body_text, m.body_html, 0, 0`)

func messageColsWith(body string) string {
	return `
	m.id, mb.conversation_id, coalesce(m.sender_id, 0), coalesce(su.addr_key, ''),
	CASE WHEN su.id IS NULL THEN '` + DeletedName + `' ELSE su.display_name END, coalesce(su.avatar_url, ''),
	m.subject, ` + body + `, m.snippet, m.parent_id, m.root_id, m.depth,
	m.forwarded_from_id, m.has_attachments, m.sent_at,
	mb.folder, mb.is_read, mb.is_favourite, mb.is_replied, mb.is_mine`
}

const messageFrom = `
	FROM mailbox mb
	JOIN messages m ON m.id = mb.message_id
	LEFT JOIN users su ON su.id = m.sender_id` // no user: the sender deleted their account

// scanMessages reads rows selected with messageCols (list: bodies cut to a preview)
// or fullMessageCols (full bodies).
func (s *Service) scanMessages(rows pgx.Rows) ([]MessageView, error) {
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (MessageView, error) {
		var v MessageView
		var local string
		var textLen, htmlLen int
		err := r.Scan(&v.ID, &v.ConversationID, &v.Sender.UserID, &local, &v.Sender.DisplayName, &v.Sender.AvatarURL,
			&v.Subject, &v.BodyText, &v.BodyHTML, &textLen, &htmlLen, &v.Snippet, &v.ParentID, &v.RootID, &v.Depth,
			&v.ForwardedFromID, &v.HasAttachments, &v.SentAt,
			&v.Folder, &v.IsRead, &v.IsFavourite, &v.IsReplied, &v.IsMine)
		if local != "" {
			v.Sender.Address = s.AddressOf(local)
		}
		if textLen > 0 || htmlLen > 0 { // a list row: lengths are only selected for lists
			previewBody(&v, textLen, htmlLen)
		}
		return v, err
	})
}

// previewBody cuts a listed message to PreviewChars of visible text. The visible text is
// the plain body, or for an HTML-only email the HTML's text. A cut message loses its HTML
// (a half tag list would be broken) and gets Truncated, so the app shows "open to read more".
func previewBody(v *MessageView, textLen, htmlLen int) {
	visible := v.BodyText
	if textLen == 0 {
		if htmlLen <= maxListHTML {
			visible = stripTags(v.BodyHTML)
		} else {
			visible = v.Snippet // the HTML wasn't fetched; the snippet is its text's start
		}
	}
	if utf8.RuneCountInString(visible) <= PreviewChars && htmlLen <= maxListHTML {
		return
	}
	v.Truncated = true
	v.BodyText = cutPreview(visible, PreviewChars)
	v.BodyHTML = ""
}

// cutPreview shortens text to at most max characters, preferring to end at a space
// near the limit rather than mid-word, and adds "…". Line breaks are kept.
func cutPreview(text string, max int) string {
	r := []rune(text)
	if len(r) <= max {
		return text
	}
	cut := max
	for i := max; i > max-20 && i > 0; i-- {
		if unicode.IsSpace(r[i]) {
			cut = i
			break
		}
	}
	return strings.TrimRightFunc(string(r[:cut]), unicode.IsSpace) + "…"
}

// ChatMessages opens a chat: newest first, paged. Opening the first page marks the chat read.
func (s *Service) ChatMessages(ctx context.Context, userID, convID int64, cur Cursor) ([]MessageView, error) {
	if err := s.requireParticipant(ctx, userID, convID); err != nil {
		return nil, err
	}
	var before *time.Time
	if cur.Before != nil {
		before = cur.Before
	}
	rows, err := s.DB.Query(ctx, `SELECT `+messageCols+messageFrom+`
		WHERE mb.user_id = $1 AND mb.conversation_id = $2 AND mb.folder = 'inbox'
		  AND ($3::timestamptz IS NULL OR (mb.received_at, mb.message_id) < ($3, $4))
		ORDER BY mb.received_at DESC, mb.message_id DESC
		LIMIT $5`, userID, convID, before, cur.BeforeID, cur.limit())
	if err != nil {
		return nil, err
	}
	msgs, err := s.scanMessages(rows)
	if err != nil {
		return nil, err
	}
	if err := s.fillDetails(ctx, userID, msgs); err != nil {
		return nil, err
	}
	if cur.Before == nil {
		if err := s.MarkChatRead(ctx, userID, convID); err != nil {
			return nil, err
		}
	}
	return msgs, nil
}

// Thread returns a whole thread in display order (by path), as this user can see it in this chat.
func (s *Service) Thread(ctx context.Context, userID, convID, rootID int64) ([]MessageView, error) {
	if err := s.requireParticipant(ctx, userID, convID); err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(ctx, `SELECT `+messageCols+messageFrom+`
		WHERE mb.user_id = $1 AND mb.conversation_id = $2 AND m.root_id = $3 AND mb.folder <> 'trash'
		ORDER BY m.path`, userID, convID, rootID)
	if err != nil {
		return nil, err
	}
	msgs, err := s.scanMessages(rows)
	if err != nil {
		return nil, err
	}
	if len(msgs) == 0 {
		return nil, errNotFound("Thread not found.")
	}
	return msgs, s.fillDetails(ctx, userID, msgs)
}

// Message is the traditional view of one message. Opening it marks it read.
func (s *Service) Message(ctx context.Context, userID, msgID int64, convID *int64) (MessageView, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+fullMessageCols+messageFrom+`
		WHERE mb.user_id = $1 AND mb.message_id = $2 AND ($3::bigint IS NULL OR mb.conversation_id = $3)
		ORDER BY (mb.folder = 'inbox') DESC, mb.conversation_id LIMIT 1`, userID, msgID, convID)
	if err != nil {
		return MessageView{}, err
	}
	msgs, err := s.scanMessages(rows)
	if err != nil {
		return MessageView{}, err
	}
	if len(msgs) == 0 {
		return MessageView{}, errNotFound("Message not found.")
	}
	if err := s.fillDetails(ctx, userID, msgs); err != nil {
		return MessageView{}, err
	}
	if !msgs[0].IsRead {
		read := true
		if err := s.UpdatePointer(ctx, userID, msgID, &msgs[0].ConversationID, PointerPatch{IsRead: &read}); err != nil {
			return MessageView{}, err
		}
		msgs[0].IsRead = true
	}
	return msgs[0], nil
}

// Folder lists pointers in Spam or Trash.
func (s *Service) Folder(ctx context.Context, userID int64, folder string, cur Cursor) ([]MessageView, error) {
	if folder != "spam" && folder != "trash" {
		return nil, errBadRequest("folder must be spam or trash.")
	}
	rows, err := s.DB.Query(ctx, `SELECT `+messageCols+messageFrom+`
		WHERE mb.user_id = $1 AND mb.folder = $2
		  AND ($3::timestamptz IS NULL OR (mb.received_at, mb.message_id) < ($3, $4))
		ORDER BY mb.received_at DESC, mb.message_id DESC
		LIMIT $5`, userID, folder, cur.Before, cur.BeforeID, cur.limit())
	if err != nil {
		return nil, err
	}
	msgs, err := s.scanMessages(rows)
	if err != nil {
		return nil, err
	}
	return msgs, s.fillDetails(ctx, userID, msgs)
}

// fillDetails adds recipients (as this viewer may see them) and attachments, in two queries.
func (s *Service) fillDetails(ctx context.Context, viewerID int64, msgs []MessageView) error {
	if len(msgs) == 0 {
		return nil
	}
	ids := make([]int64, len(msgs))
	index := map[int64][]int{}
	for i, m := range msgs {
		ids[i] = m.ID
		index[m.ID] = append(index[m.ID], i)
	}

	rows, err := s.DB.Query(ctx, `
		SELECT r.message_id, r.kind, coalesce(m.sender_id, 0), u.id, u.addr_key, u.display_name, u.avatar_url, g.id, g.name
		FROM message_recipients r
		JOIN messages m ON m.id = r.message_id
		LEFT JOIN users u ON u.id = r.user_id
		LEFT JOIN conversations g ON g.id = r.group_id
		WHERE r.message_id = ANY($1)
		ORDER BY r.message_id, CASE r.kind WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END, r.id`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var msgID, senderID int64
		var kind string
		var uid, gid *int64
		var local, name, avatar, gname *string
		if err := rows.Scan(&msgID, &kind, &senderID, &uid, &local, &name, &avatar, &gid, &gname); err != nil {
			return err
		}
		// Bcc is visible only to the sender, and to each Bcc person about themselves.
		if kind == "bcc" && viewerID != senderID && (uid == nil || *uid != viewerID) {
			continue
		}
		rv := RecipientView{Kind: kind}
		if uid != nil {
			rv.Person = &Person{UserID: *uid, Address: s.AddressOf(*local), DisplayName: *name, AvatarURL: *avatar}
		} else if gid != nil {
			rv.GroupID, rv.Group = *gid, *gname
		} else {
			rv.Person = &Person{DisplayName: DeletedName} // a person who deleted their account
		}
		for _, i := range index[msgID] {
			msgs[i].Recipients = append(msgs[i].Recipients, rv)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	arows, err := s.DB.Query(ctx, `SELECT message_id, id, filename, content_type, size_bytes
		FROM attachments WHERE message_id = ANY($1) ORDER BY id`, ids)
	if err != nil {
		return err
	}
	defer arows.Close()
	for arows.Next() {
		var msgID int64
		var a AttachmentInfo
		if err := arows.Scan(&msgID, &a.ID, &a.Filename, &a.ContentType, &a.SizeBytes); err != nil {
			return err
		}
		for _, i := range index[msgID] {
			msgs[i].Attachments = append(msgs[i].Attachments, a)
		}
	}
	if err := arows.Err(); err != nil {
		return err
	}
	return s.fillReactions(ctx, viewerID, ids, index, msgs)
}

func (s *Service) requireParticipant(ctx context.Context, userID, convID int64) error {
	var ok bool
	if err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversation_participants
		WHERE conversation_id = $1 AND user_id = $2)`, convID, userID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return errNotFound("Chat not found.")
	}
	return nil
}

// SearchResult groups what a search found.
type SearchResult struct {
	Messages []MessageView `json:"messages"`
	People   []PersonMatch `json:"people"`
	Groups   []Group       `json:"groups"`
}

type PersonMatch struct {
	Person
	ConversationID *int64 `json:"conversation_id,omitempty"` // their direct chat with you, if any
}

var (
	wordRe     = regexp.MustCompile(`[\p{L}\p{N}]+`)
	likeEscape = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
)

// Search finds messages (full text, not Trash), a person by phone/alias, and groups by name.
func (s *Service) Search(ctx context.Context, userID int64, q string) (SearchResult, error) {
	res := SearchResult{Messages: []MessageView{}, People: []PersonMatch{}, Groups: []Group{}}
	q = strings.TrimSpace(q)
	if q == "" {
		return res, nil
	}
	f, err := s.parseSearch(ctx, userID, q)
	if err != nil {
		return res, err
	}

	// Messages: every word of 2+ characters as a prefix, e.g. "meet tom" -> meet:* & tom:*.
	// One-letter prefixes match almost everything, so they are left out.
	var words []string
	for _, w := range wordRe.FindAllString(strings.ToLower(f.text), 8) {
		if utf8.RuneCountInString(w) >= 2 {
			words = append(words, w+":*")
		}
	}
	if len(words) > 0 || f.ops {
		// Searched from the user's own mailbox, never the whole service: the cost grows with
		// what one person has, not with everyone's mail. One pointer per message (the same
		// message can sit in two chats).
		conds := append([]string{"mb.user_id = $1"}, f.conds...)
		if len(words) > 0 {
			f.args = append(f.args, strings.Join(words, " & "))
			conds = append(conds, fmt.Sprintf("m.search @@ to_tsquery('simple', $%d)", len(f.args)+1))
		}
		rows, err := s.DB.Query(ctx, `
			WITH hits AS (
				SELECT DISTINCT ON (mb.message_id) mb.*
				FROM mailbox mb JOIN messages m ON m.id = mb.message_id
				WHERE `+strings.Join(conds, " AND ")+`
				ORDER BY mb.message_id, mb.conversation_id
			)
			SELECT `+messageCols+`
			FROM hits mb
			JOIN messages m ON m.id = mb.message_id
			LEFT JOIN users su ON su.id = m.sender_id
			ORDER BY m.sent_at DESC LIMIT 50`, append([]any{userID}, f.args...)...)
		if err != nil {
			return res, err
		}
		if res.Messages, err = s.scanMessages(rows); err != nil {
			return res, err
		}
		if err := s.fillDetails(ctx, userID, res.Messages); err != nil {
			return res, err
		}
	}
	// People and groups are looked up by the plain words only.
	q = strings.TrimSpace(f.text)
	if q == "" {
		return res, nil
	}

	// A person, by phone number, address or alias.
	if uid, err := s.resolveAddress(ctx, s.DB, q); err == nil && uid != userID {
		var pm PersonMatch
		var local string
		if err := s.DB.QueryRow(ctx, `SELECT id, addr_key, display_name, avatar_url FROM users WHERE id = $1`, uid).
			Scan(&pm.UserID, &local, &pm.DisplayName, &pm.AvatarURL); err != nil {
			return res, err
		}
		pm.Address = s.AddressOf(local)
		var convID int64
		err := s.DB.QueryRow(ctx, `SELECT id FROM conversations WHERE kind = 'direct' AND participant_hash = $1`,
			ParticipantHash([]int64{userID, uid})).Scan(&convID)
		if err == nil {
			pm.ConversationID = &convID
		} else if err != pgx.ErrNoRows {
			return res, err
		}
		res.People = append(res.People, pm)
	}

	// Groups the user is in, by name.
	rows, err := s.DB.Query(ctx, `SELECT c.id, c.name, c.created_at FROM conversations c
		JOIN conversation_participants p ON p.conversation_id = c.id
		WHERE p.user_id = $1 AND p.left_at IS NULL AND c.kind = 'group' AND c.name ILIKE '%' || $2 || '%'
		ORDER BY c.name LIMIT 20`, userID, likeEscape.Replace(q))
	if err != nil {
		return res, err
	}
	res.Groups, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Group, error) {
		var g Group
		err := r.Scan(&g.ConversationID, &g.Name, &g.CreatedAt)
		return g, err
	})
	return res, err
}
