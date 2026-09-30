package mail

import (
	"bytes"
	"encoding/json"
	"time"
)

// Recipient names one receiver: a person (by address, alias or phone number) or a group
// (by id, or by name among the sender's groups). Exactly one field is set. An address
// that matches no person is also tried as the name of one of the sender's groups.
type Recipient struct {
	Address string `json:"address,omitempty"`
	GroupID int64  `json:"group_id,omitempty"`
	Group   string `json:"group,omitempty"` // a group name, e.g. "Goa crew"
}

// Recipients is the To/Cc/Bcc set of a new message (and of a draft).
type Recipients struct {
	To  ToList      `json:"to,omitempty"`
	Cc  []Recipient `json:"cc,omitempty"`
	Bcc []Recipient `json:"bcc,omitempty"`
	// GroupName names the group started when To holds two or more people; optional.
	GroupName string `json:"group_name,omitempty"`
}

// ToList is the To field: one person or group, or two or more people, which
// starts (or reuses) a group chat with them (the brief's Home rule; see Send).
// In JSON it is a single recipient object, or an array of them.
type ToList []Recipient

func (t *ToList) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	switch {
	case bytes.Equal(b, []byte("null")):
		*t = nil
		return nil
	case len(b) > 0 && b[0] == '[':
		var list []Recipient
		if err := json.Unmarshal(b, &list); err != nil {
			return err
		}
		*t = list
		return nil
	}
	var one Recipient
	if err := json.Unmarshal(b, &one); err != nil {
		return err
	}
	*t = ToList{one}
	return nil
}

// MarshalJSON writes a single recipient as an object, as before multi-person To existed.
func (t ToList) MarshalJSON() ([]byte, error) {
	if len(t) == 1 {
		return json.Marshal(t[0])
	}
	return json.Marshal([]Recipient(t))
}

// SendRequest starts a new thread (spec 6.1).
// Composing inside a chat: set ConversationID and leave To/Cc/Bcc empty (recipients are locked).
type SendRequest struct {
	Recipients
	ConversationID  *int64 `json:"conversation_id,omitempty"`
	Subject         string `json:"subject"`
	BodyText        string `json:"body_text"`
	BodyHTML        string `json:"body_html"`
	ForwardedFromID *int64 `json:"forwarded_from_id,omitempty"`
	DraftID         *int64 `json:"draft_id,omitempty"`
	sendOpts
}

// sendOpts are set by the service itself, never by a client.
type sendOpts struct {
	dryRun    bool // check everything, then roll back: nothing is sent
	scheduled bool // sent by the scheduler: the draft must still be due (not taken back)
}

// ReplyRequest answers a message inside a chat (spec 6.2). Recipients are locked.
type ReplyRequest struct {
	ConversationID int64  `json:"conversation_id"`
	BodyText       string `json:"body_text"`
	BodyHTML       string `json:"body_html"`
	DraftID        *int64 `json:"draft_id,omitempty"`
	sendOpts
}

// SendResult says where a message landed.
type SendResult struct {
	MessageID     int64   `json:"message_id"`
	Conversations []int64 `json:"conversation_ids"`
}

// DeletedName is shown instead of a person who deleted their account.
const DeletedName = "Deleted account"

// Person is a user as other users see them.
type Person struct {
	UserID      int64  `json:"user_id"`
	Address     string `json:"address"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

// ChatSummary is one row of the Home screen.
type ChatSummary struct {
	ConversationID int64      `json:"conversation_id"`
	Kind           string     `json:"kind"`
	Name           string     `json:"name,omitempty"` // group name
	Peer           *Person    `json:"peer,omitempty"` // the other person, for direct chats
	MemberCount    int        `json:"member_count,omitempty"`
	LastMessageAt  time.Time  `json:"last_message_at"`
	LastMessageID  *int64     `json:"last_message_id,omitempty"`
	Snippet        string     `json:"snippet"`
	UnreadCount    int        `json:"unread_count"`
	HasAttachments bool       `json:"has_attachments"`
	FavouriteCount int        `json:"favourite_count"`
	Archived       bool       `json:"archived,omitempty"`
	Muted          bool       `json:"muted,omitempty"`
	SnoozedUntil   *time.Time `json:"snoozed_until,omitempty"`
}

// RecipientView is a recipient as shown to a particular viewer.
type RecipientView struct {
	Kind    string  `json:"kind"` // to, cc, bcc
	Person  *Person `json:"person,omitempty"`
	GroupID int64   `json:"group_id,omitempty"`
	Group   string  `json:"group_name,omitempty"`
}

// AttachmentInfo describes a file (the bytes are served separately).
type AttachmentInfo struct {
	ID          int64  `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

// MessageView is a message plus the viewer's flags on it.
type MessageView struct {
	ID             int64  `json:"id"`
	ConversationID int64  `json:"conversation_id"`
	Sender         Person `json:"sender"`
	Subject        string `json:"subject"`
	BodyText       string `json:"body_text"`
	BodyHTML       string `json:"body_html,omitempty"`
	Snippet        string `json:"snippet"`
	// Truncated: this is a list, the message is longer than PreviewChars, and BodyText
	// holds only its start (BodyHTML is empty). GET /messages/{id} returns it in full.
	Truncated       bool             `json:"truncated,omitempty"`
	ParentID        *int64           `json:"parent_id,omitempty"`
	RootID          int64            `json:"root_id"`
	Depth           int              `json:"depth"`
	ForwardedFromID *int64           `json:"forwarded_from_id,omitempty"`
	HasAttachments  bool             `json:"has_attachments"`
	SentAt          time.Time        `json:"sent_at"`
	Folder          string           `json:"folder"`
	IsRead          bool             `json:"is_read"`
	IsFavourite     bool             `json:"is_favourite"`
	IsReplied       bool             `json:"is_replied"`
	IsMine          bool             `json:"is_mine"`
	Recipients      []RecipientView  `json:"recipients,omitempty"`
	Attachments     []AttachmentInfo `json:"attachments,omitempty"`
	Reactions       []Reaction       `json:"reactions,omitempty"`
}

// Reaction is one emoji on a message, with who chose it.
type Reaction struct {
	Emoji string   `json:"emoji"`
	Count int      `json:"count"`
	Mine  bool     `json:"mine,omitempty"`
	Names []string `json:"names"`
}

// Draft is a user's unsent email.
type Draft struct {
	ID             int64            `json:"id"`
	ConversationID *int64           `json:"conversation_id,omitempty"`
	ParentID       *int64           `json:"parent_id,omitempty"`
	Recipients     Recipients       `json:"recipients"`
	Subject        string           `json:"subject"`
	BodyText       string           `json:"body_text"`
	BodyHTML       string           `json:"body_html"`
	UpdatedAt      time.Time        `json:"updated_at"`
	Attachments    []AttachmentInfo `json:"attachments,omitempty"`
	// ForwardedFromID: this draft forwards that message (its files go along when sent).
	ForwardedFromID *int64 `json:"forwarded_from_id,omitempty"`
	// SendAt: the draft is waiting to be sent then (scheduled send, or undo send).
	SendAt *time.Time `json:"send_at,omitempty"`
	// SendError: a scheduled send failed and why; the draft is back to an ordinary draft.
	SendError string `json:"send_error,omitempty"`
}

// Group describes a group chat and its current members.
type Group struct {
	ConversationID int64         `json:"conversation_id"`
	Name           string        `json:"name"`
	CreatedAt      time.Time     `json:"created_at"`
	Members        []GroupMember `json:"members"`
	Created        bool          `json:"created,omitempty"` // true if this call created it
}

type GroupMember struct {
	Person
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
}

// Cursor pages through lists newest-first: pass back the last item's time and id.
type Cursor struct {
	Before   *time.Time
	BeforeID int64
	Limit    int
}

func (c Cursor) limit() int {
	if c.Limit <= 0 || c.Limit > 100 {
		return 30
	}
	return c.Limit
}
