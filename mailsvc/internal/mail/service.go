// Package mail is the heart of the PhoneMail mail service: storing messages once,
// giving each user pointers with their own flags, chats, groups, threads and drafts.
package mail

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	DB             *pgxpool.Pool
	Domain         string
	AttachmentDir  string
	MaxAttachment  int64
	TrashRetention time.Duration
	Limits         Limits
	// Mail to other providers goes to this SMTP relay (the host's Postfix, e.g. 172.28.0.1:25).
	// Empty: email to outside addresses is refused (ErrExternalMail).
	SMTPRelay    string
	SMTPHostname string // our name in SMTP greetings, e.g. mail.phonemail.net
	// Earlier domains whose addresses still reach the same people (e.g. after a
	// move): 9876543210@legacy.example is 9876543210@<Domain>. Receiving only.
	LegacyDomains map[string]bool
	// Ordinary mailboxes on our domains that aren't PhoneMail accounts (OTHER_MAILBOXES), e.g.
	// office@phonemail.com: mail to them goes through Postfix.
	OtherMailboxes map[string]bool
}

// Limits keep one account from using up the server (disk, database, SMS alerts).
// Zero fields mean the defaults below.
type Limits struct {
	MaxRecipients   int   // MAX_RECIPIENTS: To + Cc + Bcc entries per message
	MaxGroupMembers int   // MAX_GROUP_MEMBERS
	MaxDrafts       int   // MAX_DRAFTS per user
	MaxDraftFiles   int   // MAX_DRAFT_FILES: attachments per draft
	MaxUserStorage  int64 // MAX_USER_STORAGE_MB: bytes of attachments one user may have uploaded
}

// Sizes of what people type. A subject is one line; bodies are generous for email
// but keep the search index (and a PostgreSQL tsvector's 1 MB cap) in range.
const (
	MaxSubjectChars = 255
	MaxBodyText     = 256 << 10 // bytes
	MaxBodyHTML     = 1 << 20   // bytes
)

func (s *Service) limits() Limits {
	l := s.Limits
	def := func(v *int, d int) {
		if *v <= 0 {
			*v = d
		}
	}
	def(&l.MaxRecipients, 50)
	def(&l.MaxGroupMembers, 256)
	def(&l.MaxDrafts, 200)
	def(&l.MaxDraftFiles, 20)
	if l.MaxUserStorage <= 0 {
		l.MaxUserStorage = 1 << 30
	}
	return l
}

// NotifyChannel is the PostgreSQL LISTEN/NOTIFY channel the API service listens on.
const NotifyChannel = "mail_events"

// querier is anything that can run a single-row query: the pool or a transaction.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// tx runs fn in a transaction, committing only if fn returns nil.
func (s *Service) tx(ctx context.Context, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, s.DB, fn)
}

// ParticipantHash identifies a set of users regardless of order (spec 3).
func ParticipantHash(userIDs []int64) string {
	ids := append([]int64(nil), userIDs...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	parts := make([]string, 0, len(ids))
	var prev int64 = -1
	for _, id := range ids {
		if id == prev {
			continue // duplicates don't change the set
		}
		parts = append(parts, strconv.FormatInt(id, 10))
		prev = id
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, ",")))
	return hex.EncodeToString(sum[:])
}

// Snippet is the first ~120 characters of a body, on one line.
func Snippet(body string) string {
	s := strings.Join(strings.Fields(body), " ")
	if utf8.RuneCountInString(s) <= 120 {
		return s
	}
	r := []rune(s)
	return string(r[:120]) + "…"
}

func (s *Service) newMessageIDHeader(id int64) string {
	b := make([]byte, 8)
	rand.Read(b) //nolint:errcheck // crypto/rand never fails on supported platforms
	return fmt.Sprintf("<%d.%s@%s>", id, hex.EncodeToString(b), s.Domain)
}

// AddressOf returns a user's main address from their addr_key: 10 digits become
// 9876543210@phonemail.com; a person outside PhoneMail's key is already their address.
func (s *Service) AddressOf(key string) string {
	if strings.Contains(key, "@") {
		return key
	}
	return key + "@" + s.Domain
}

var nonDigit = regexp.MustCompile(`[^0-9]`)

// ourDomain reports whether an address is on our domain or an earlier (legacy) one.
func (s *Service) ourDomain(addr string) bool {
	_, d, _ := strings.Cut(strings.ToLower(addr), "@")
	return d == s.Domain || s.LegacyDomains[d]
}

// resolveAddress maps an address, alias or bare phone number to a user id.
func (s *Service) resolveAddress(ctx context.Context, q querier, raw string) (int64, error) {
	addr := strings.ToLower(strings.TrimSpace(raw))
	if addr == "" {
		return 0, errBadRequest("Empty recipient address.")
	}
	local, domain, hasAt := strings.Cut(addr, "@")
	if !hasAt && len(nonDigit.ReplaceAllString(local, "")) < 10 {
		// A bare alias name like "kavya" means kavya@<our domain>.
		addr, domain, hasAt = local+"@"+s.Domain, s.Domain, true
	}
	if hasAt && domain != s.Domain && s.LegacyDomains[domain] {
		addr, domain = local+"@"+s.Domain, s.Domain // an old address: the same person
	}
	if hasAt && domain != s.Domain {
		return 0, ErrExternalMail
	}
	var userID int64
	// Phone number (bare, or as the local part): match on the last 10 digits.
	if digits := nonDigit.ReplaceAllString(local, ""); len(digits) >= 10 && (!hasAt || digits == local) {
		err := q.QueryRow(ctx, `SELECT id FROM users WHERE phone_local = $1`, digits[len(digits)-10:]).Scan(&userID)
		if err == nil {
			return userID, nil
		}
		if err != pgx.ErrNoRows {
			return 0, err
		}
	}
	if hasAt {
		err := q.QueryRow(ctx, `SELECT user_id FROM aliases WHERE alias = $1`, addr).Scan(&userID)
		if err == nil {
			return userID, nil
		}
		if err != pgx.ErrNoRows {
			return 0, err
		}
	}
	return 0, errNotFound("No PhoneMail user has the address %q.", raw)
}

// requireUser checks the caller exists.
func (s *Service) RequireUser(ctx context.Context, userID int64) error {
	var ok bool
	if err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return &Error{401, "unknown_user", "Unknown user."}
	}
	return nil
}

// isCurrentMember reports whether a user is a current member of a conversation.
func isCurrentMember(ctx context.Context, q pgx.Tx, convID, userID int64) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversation_participants
		WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL)`, convID, userID).Scan(&ok)
	return ok, err
}

// event is published with pg_notify inside the transaction, so the API only
// hears about it once the transaction commits.
type event struct {
	Type           string  `json:"type"` // "message", "group"
	MessageID      int64   `json:"message_id,omitempty"`
	ConversationID int64   `json:"conversation_id"`
	SenderID       int64   `json:"sender_id,omitempty"`
	SenderAddress  string  `json:"sender_address,omitempty"`
	Subject        string  `json:"subject,omitempty"`
	UserIDs        []int64 `json:"user_ids"`        // who should be told (never the sender)
	Muted          []int64 `json:"muted,omitempty"` // of those, who muted the chat: no sound or alert
}

func notify(ctx context.Context, q pgx.Tx, ev event) error {
	// pg_notify payloads are limited to 8000 bytes: split big groups into chunks.
	const chunk = 400
	ids := ev.UserIDs
	for {
		part := ev
		if len(ids) > chunk {
			part.UserIDs, ids = ids[:chunk], ids[chunk:]
		} else {
			part.UserIDs, ids = ids, nil
		}
		b, err := json.Marshal(part)
		if err != nil {
			return err
		}
		if _, err := q.Exec(ctx, `SELECT pg_notify($1, $2)`, NotifyChannel, string(b)); err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
	}
}
