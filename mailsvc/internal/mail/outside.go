package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"mime"
	"mime/quotedprintable"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Mail to and from other providers (Gmail, Outlook…), through the host's Postfix, with the same
// standard interface: Postfix hands incoming mail to ServeSMTP (inbound.go), and
// outgoing mail waits in the outbox until RunOutbound hands it to Postfix (SMTPRelay), which
// DKIM-signs and delivers it. Mail between PhoneMail people never leaves the database.
//
// Someone outside PhoneMail is an "external" user: an email address, no phone and no sign-in.
// They only ever share one-to-one chats; groups are PhoneMail-only (decided 30 Sep).

// ErrOutsideGroup: an outside address was given as a group member.
var ErrOutsideGroup = &Error{400, "outside_group", "People outside PhoneMail can't be in a group. Email them on their own."}

// outsideGroup turns "can't email outside" into the group rule when adding group members.
func outsideGroup(err error) error {
	if errors.Is(err, ErrExternalMail) {
		return ErrOutsideGroup
	}
	return err
}

// resolveRecipient is resolveAddress for sending: an address at another provider becomes an
// external user (created on first use) when outside mail is on.
func (s *Service) resolveRecipient(ctx context.Context, tx pgx.Tx, raw string) (int64, error) {
	if s.OtherMailboxes[strings.ToLower(strings.TrimSpace(raw))] && s.SMTPRelay != "" {
		// An ordinary mailbox on our own domain (Dovecot, e.g. office@phonemail.com): it's
		// handed to Postfix like any outside address, and Postfix delivers it locally.
		return s.externalUser(ctx, tx, raw, "")
	}
	id, err := s.resolveAddress(ctx, tx, raw)
	if !errors.Is(err, ErrExternalMail) || s.SMTPRelay == "" {
		return id, err
	}
	return s.externalUser(ctx, tx, raw, "")
}

// externalUser finds or creates the user for an outside address, keeping the first name seen.
func (s *Service) externalUser(ctx context.Context, tx pgx.Tx, raw, name string) (int64, error) {
	a, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil || !strings.Contains(a.Address, "@") || len(a.Address) > 254 {
		return 0, errBadRequest("%q isn't a valid email address.", raw)
	}
	if name == "" {
		name = a.Name
	}
	name = strings.TrimSpace(strings.Join(strings.Fields(name), " "))
	if utf8.RuneCountInString(name) > 60 {
		name = string([]rune(name)[:60])
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO users (external_address, display_name, created_via) VALUES ($1, $2, 'external')
		ON CONFLICT (external_address) DO UPDATE
		SET display_name = CASE WHEN users.display_name = '' THEN EXCLUDED.display_name ELSE users.display_name END
		RETURNING id`, strings.ToLower(a.Address), name).Scan(&id)
	return id, err
}

// outsiders lists which of these users are outside PhoneMail.
func outsiders(ctx context.Context, tx pgx.Tx, ids []int64) ([]int64, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM users WHERE id = ANY($1) AND external_address IS NOT NULL`, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[int64])
}

// queueOutside puts a message in the outbox (once, however many outside recipients it has).
func queueOutside(ctx context.Context, tx pgx.Tx, msgID int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO outbox (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING`, msgID)
	return err
}

// ---- outgoing ----

const maxOutboxAttempts = 8

// RunOutbound hands waiting outside email to Postfix until ctx ends. Without a relay the
// outbox stays as it is (nothing is queued then anyway: outside addresses are refused).
func (s *Service) RunOutbound(ctx context.Context, every time.Duration) {
	if s.SMTPRelay == "" {
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		for s.sendOneOutside(ctx) {
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// sendOneOutside sends the oldest due outbox email; it reports whether there was one.
// Temporary failures retry after 1, 2, 4… minutes; a 5xx answer or 8 tries give up.
func (s *Service) sendOneOutside(ctx context.Context) bool {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		log.Printf("outbound: %v", err)
		return false
	}
	defer tx.Rollback(ctx)
	var id, msgID int64
	var attempts int
	err = tx.QueryRow(ctx, `SELECT id, message_id, attempts FROM outbox
		WHERE status = 'pending' AND next_attempt_at <= now()
		ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id, &msgID, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		log.Printf("outbound: %v", err)
		return false
	}
	email, err := s.renderEmail(ctx, tx, msgID)
	if err == nil && len(email.outside) == 0 {
		err = &textproto.Error{Code: 550, Msg: "no outside recipients"}
	}
	if err == nil {
		err = s.relay(email)
	}
	attempts++
	switch {
	case err == nil:
		_, err = tx.Exec(ctx, `UPDATE outbox SET status = 'sent', attempts = $2, sent_at = now(), last_error = NULL WHERE id = $1`, id, attempts)
	case permanentSMTP(err) || attempts >= maxOutboxAttempts:
		log.Printf("outbound: message %d failed for good: %v", msgID, err)
		_, err = tx.Exec(ctx, `UPDATE outbox SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1`, id, attempts, err.Error())
	default:
		wait := time.Minute << (attempts - 1)
		log.Printf("outbound: message %d will be retried in %s: %v", msgID, wait, err)
		_, err = tx.Exec(ctx, `UPDATE outbox SET attempts = $2, last_error = $3, next_attempt_at = now() + $4 WHERE id = $1`,
			id, attempts, err.Error(), wait)
	}
	if err != nil {
		log.Printf("outbound: %v", err)
		return false
	}
	return tx.Commit(ctx) == nil
}

func permanentSMTP(err error) bool {
	var te *textproto.Error
	return errors.As(err, &te) && te.Code >= 500
}

// relay hands one email to Postfix. One refused address doesn't stop the others.
func (s *Service) relay(e *email) error {
	c, err := smtp.Dial(s.SMTPRelay)
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.Hello(s.SMTPHostname); err != nil {
		return err
	}
	if err := c.Mail(e.from); err != nil {
		return err
	}
	accepted := 0
	var lastErr error
	for _, r := range e.outside {
		if err := c.Rcpt(r); err != nil {
			lastErr = err
			continue
		}
		accepted++
	}
	if accepted == 0 {
		return lastErr
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(e.data); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// email is a stored message written out as an RFC 5322 email for outside recipients.
type email struct {
	from    string
	outside []string // the SMTP envelope: outside To, Cc and Bcc (Bcc never appears in the headers)
	data    []byte
}

// renderEmail writes a message as an email: From, To/Cc (PhoneMail people by their address,
// a group by its name as an empty RFC 5322 group), threading headers for mail apps, text and
// HTML alternatives, and the attachments.
func (s *Service) renderEmail(ctx context.Context, q pgx.Tx, msgID int64) (*email, error) {
	var subject, text, html, msgHeader, path, fromKey, fromName string
	var sentAt time.Time
	err := q.QueryRow(ctx, `SELECT m.subject, m.body_text, m.body_html, m.message_id_header, m.path::text, m.sent_at,
			u.addr_key, u.display_name
		FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, msgID).
		Scan(&subject, &text, &html, &msgHeader, &path, &sentAt, &fromKey, &fromName)
	if err != nil {
		return nil, err
	}
	rows, err := q.Query(ctx, `SELECT r.kind, coalesce(u.addr_key, ''), u.external_address IS NOT NULL, coalesce(g.name, '')
		FROM message_recipients r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN conversations g ON g.id = r.group_id
		WHERE r.message_id = $1 ORDER BY r.id`, msgID)
	if err != nil {
		return nil, err
	}
	out := &email{from: s.AddressOf(fromKey)}
	var to, cc []string
	for rows.Next() {
		var kind, key, group string
		var outside *bool
		if err := rows.Scan(&kind, &key, &outside, &group); err != nil {
			rows.Close()
			return nil, err
		}
		shown := ""
		switch {
		case key != "":
			shown = s.AddressOf(key)
		case group != "":
			shown = mime.QEncoding.Encode("utf-8", strings.NewReplacer(";", ",", ":", " ").Replace(group)) + ":;"
		}
		if shown != "" && kind == "to" {
			to = append(to, shown)
		} else if shown != "" && kind == "cc" {
			cc = append(cc, shown)
		}
		if outside != nil && *outside {
			out.outside = append(out.outside, s.AddressOf(key))
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// The earlier emails of the thread, oldest first: mail apps thread on these.
	var refs []string
	if strings.Contains(path, ".") {
		r, err := q.Query(ctx, `SELECT message_id_header FROM messages WHERE path @> $1::ltree AND id <> $2 ORDER BY depth`, path, msgID)
		if err != nil {
			return nil, err
		}
		if refs, err = pgx.CollectRows(r, pgx.RowTo[string]); err != nil {
			return nil, err
		}
	}
	type file struct{ name, ctype, path string }
	arows, err := q.Query(ctx, `SELECT filename, content_type, storage_path FROM attachments WHERE message_id = $1 ORDER BY id`, msgID)
	if err != nil {
		return nil, err
	}
	files, err := pgx.CollectRows(arows, func(r pgx.CollectableRow) (file, error) {
		var f file
		return f, r.Scan(&f.name, &f.ctype, &f.path)
	})
	if err != nil {
		return nil, err
	}

	var b bytes.Buffer
	h := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	h("From", (&mail.Address{Name: fromName, Address: out.from}).String())
	if len(to) > 0 {
		h("To", strings.Join(to, ", "))
	}
	if len(cc) > 0 {
		h("Cc", strings.Join(cc, ", "))
	}
	h("Subject", mime.QEncoding.Encode("utf-8", subject))
	h("Date", sentAt.Format(time.RFC1123Z))
	h("Message-ID", msgHeader)
	if len(refs) > 0 {
		h("In-Reply-To", refs[len(refs)-1])
		h("References", strings.Join(refs, " "))
	}
	h("MIME-Version", "1.0")
	h("X-Mailer", "PhoneMail")
	body := func() {
		if html == "" {
			textPart(&b, text)
			return
		}
		alt := boundary()
		b.WriteString(`Content-Type: multipart/alternative; boundary="` + alt + "\"\r\n\r\n--" + alt + "\r\n")
		textPart(&b, text)
		b.WriteString("--" + alt + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
		writeQP(&b, html)
		b.WriteString("--" + alt + "--\r\n")
	}
	if len(files) == 0 {
		body()
	} else {
		mixed := boundary()
		h("Content-Type", `multipart/mixed; boundary="`+mixed+`"`)
		b.WriteString("\r\n--" + mixed + "\r\n")
		body()
		for _, f := range files {
			data, err := os.ReadFile(filepath.Join(s.AttachmentDir, f.path))
			if err != nil {
				return nil, fmt.Errorf("attachment %s: %w", f.name, err)
			}
			b.WriteString("--" + mixed + "\r\n")
			b.WriteString("Content-Type: " + mime.FormatMediaType(f.ctype, map[string]string{"name": f.name}) + "\r\n")
			b.WriteString("Content-Disposition: " + mime.FormatMediaType("attachment", map[string]string{"filename": f.name}) + "\r\n")
			b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
			enc := base64.StdEncoding.EncodeToString(data)
			for len(enc) > 76 {
				b.WriteString(enc[:76] + "\r\n")
				enc = enc[76:]
			}
			b.WriteString(enc + "\r\n")
		}
		b.WriteString("--" + mixed + "--\r\n")
	}
	out.data = b.Bytes()
	return out, nil
}

func textPart(b *bytes.Buffer, body string) {
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
	writeQP(b, body)
}

func writeQP(b *bytes.Buffer, s string) {
	qp := quotedprintable.NewWriter(b)
	qp.Write([]byte(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")))
	qp.Close()
	b.WriteString("\r\n")
}

func boundary() string {
	x := make([]byte, 12)
	rand.Read(x) //nolint:errcheck // crypto/rand never fails on supported platforms
	return "pm-" + hex.EncodeToString(x)
}
