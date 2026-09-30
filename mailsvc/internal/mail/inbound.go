package mail

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"html"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Incoming email from other providers. The host's Postfix receives it on port 25 and hands mail
// for our domain to this small SMTP server (published on 127.0.0.1:2525 only, as in the live
// build). RCPT is answered from the database, so Postfix's recipient verification refuses
// unknown addresses before accepting a message (no bounces to forged senders). Spam filtering
// is Postfix's job; a message it marks (X-Spam-Flag: YES) lands in Spam.

const maxInboundBytes = 26 << 20 // Postfix's usual message_size_limit

// ServeSMTP accepts Postfix's connections until ctx ends.
func (s *Service) ServeSMTP(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	log.Printf("inbound: SMTP on %s", addr)
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	return s.serveSMTP(ln)
}

func (s *Service) serveSMTP(ln net.Listener) error {
	slots := make(chan struct{}, 50) // Postfix opens a few at a time; this stops a flood
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		select {
		case slots <- struct{}{}:
			go func() {
				defer func() { <-slots }()
				s.smtpSession(conn)
			}()
		default:
			conn.Write([]byte("421 4.3.2 Too busy, try again later\r\n"))
			conn.Close()
		}
	}
}

func (s *Service) smtpSession(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReaderSize(conn, 4096)
	w := bufio.NewWriter(conn)
	reply := func(line string) { w.WriteString(line + "\r\n"); w.Flush() }
	ctx := context.Background()
	host := s.SMTPHostname

	reply("220 " + host + " PhoneMail ESMTP")
	var from string
	var haveFrom bool
	var rcpts []int64
	for {
		conn.SetDeadline(time.Now().Add(5 * time.Minute))
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		verb, arg, _ := strings.Cut(strings.TrimRight(line, "\r\n"), " ")
		switch strings.ToUpper(verb) {
		case "EHLO":
			w.WriteString("250-" + host + "\r\n250-8BITMIME\r\n250-SIZE " + strconv.Itoa(maxInboundBytes) + "\r\n")
			reply("250 SMTPUTF8")
		case "HELO":
			reply("250 " + host)
		case "MAIL":
			from, haveFrom, rcpts = angle(arg), true, nil
			reply("250 2.1.0 OK")
		case "RCPT":
			if !haveFrom {
				reply("503 5.5.1 MAIL first")
				continue
			}
			id, err := s.resolveAddress(ctx, s.DB, angle(arg))
			var me *Error
			switch {
			case errors.As(err, &me) && me.Status < 500:
				reply("550 5.1.1 No such PhoneMail address")
			case err != nil:
				log.Printf("inbound: rcpt: %v", err)
				reply("451 4.3.0 Try again later")
			case len(rcpts) >= 100:
				reply("452 4.5.3 Too many recipients")
			default:
				if !containsID(rcpts, id) {
					rcpts = append(rcpts, id)
				}
				reply("250 2.1.5 OK")
			}
		case "DATA":
			if len(rcpts) == 0 {
				reply("503 5.5.1 RCPT first")
				continue
			}
			reply("354 End data with <CR><LF>.<CR><LF>")
			raw, tooBig, err := readData(r)
			if err != nil {
				return
			}
			if tooBig {
				reply("552 5.3.4 Message too big")
				from, haveFrom, rcpts = "", false, nil
				continue
			}
			var me *Error
			switch err := s.DeliverInbound(ctx, from, rcpts, raw); {
			case errors.As(err, &me) && me.Status < 500:
				reply("550 5.7.1 " + me.Message)
			case err != nil:
				log.Printf("inbound: deliver: %v", err)
				reply("451 4.3.0 Try again later")
			default:
				reply("250 2.0.0 Delivered")
			}
			from, haveFrom, rcpts = "", false, nil
		case "RSET":
			from, haveFrom, rcpts = "", false, nil
			reply("250 2.0.0 OK")
		case "NOOP":
			reply("250 2.0.0 OK")
		case "VRFY":
			reply("252 2.5.0 Cannot VRFY")
		case "QUIT":
			reply("221 2.0.0 Bye")
			return
		default:
			reply("502 5.5.2 Command not recognised")
		}
	}
}

// angle takes the address out of "FROM:<a@b> SIZE=…" or "TO:<a@b>".
func angle(arg string) string {
	if i := strings.Index(arg, "<"); i >= 0 {
		if j := strings.Index(arg[i:], ">"); j > 0 {
			return strings.ToLower(strings.TrimSpace(arg[i+1 : i+j]))
		}
	}
	_, v, _ := strings.Cut(arg, ":")
	return strings.ToLower(strings.TrimSpace(v))
}

// readData reads the DATA section up to the lone dot, undoing dot-stuffing.
func readData(r *bufio.Reader) (data []byte, tooBig bool, err error) {
	var b bytes.Buffer
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, false, err
		}
		if line == ".\r\n" || line == ".\n" {
			return b.Bytes(), tooBig, nil
		}
		line = strings.TrimPrefix(line, ".")
		if b.Len()+len(line) > maxInboundBytes {
			tooBig = true
			continue
		}
		b.WriteString(line)
	}
}

var msgIDRe = regexp.MustCompile(`<[^<>\s]+>`)

// DeliverInbound stores one email from outside for the given PhoneMail people: once as a
// message, from an external user for the sender, in each recipient's one-to-one chat with them.
// An answer to a PhoneMail email joins its thread; a second answer from the same person to the
// same email threads under their first one (decided 30 Sep). The same email arriving twice
// (one copy per recipient) is stored once. Blocked senders and Postfix's spam verdict go to Spam.
func (s *Service) DeliverInbound(ctx context.Context, envFrom string, rcpts []int64, raw []byte) error {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return errBadRequest("Unreadable message.")
	}
	dec := &mime.WordDecoder{CharsetReader: charsetReader}
	fromAddr, fromName := envFrom, ""
	if a, err := (&mail.AddressParser{WordDecoder: dec}).Parse(msg.Header.Get("From")); err == nil {
		fromAddr, fromName = strings.ToLower(a.Address), a.Name
	}
	if fromAddr == "" { // a bounce (null sender) without a From
		fromAddr, fromName = "mailer-daemon@"+s.Domain, "Mail delivery system"
	}
	// PhoneMail people never send through SMTP: mail claiming to be from one is forged.
	if _, err := s.resolveAddress(ctx, s.DB, fromAddr); err == nil {
		return errBadRequest("Sender address not allowed.")
	}
	subject, err := dec.DecodeHeader(msg.Header.Get("Subject"))
	if err != nil {
		subject = msg.Header.Get("Subject")
	}
	subject = strings.TrimSpace(strings.Join(strings.Fields(subject), " "))
	if utf8.RuneCountInString(subject) > MaxSubjectChars {
		subject = string([]rune(subject)[:MaxSubjectChars])
	}
	text, htmlBody, files := extractBody(mail.Header(msg.Header), msg.Body, s.MaxAttachment)
	if len(text) > MaxBodyText {
		text = strings.ToValidUTF8(text[:MaxBodyText], "")
	}
	if len(htmlBody) > MaxBodyHTML {
		htmlBody = "" // too big to show formatted: the text version stays
	}
	if htmlBody != "" {
		htmlBody = strings.TrimSpace(htmlPolicy.Sanitize(htmlBody))
	}
	spam := strings.EqualFold(strings.TrimSpace(msg.Header.Get("X-Spam-Flag")), "yes")
	header := msgIDRe.FindString(msg.Header.Get("Message-Id"))
	parentHeader := msgIDRe.FindString(msg.Header.Get("In-Reply-To"))
	if parentHeader == "" {
		if refs := msgIDRe.FindAllString(msg.Header.Get("References"), -1); len(refs) > 0 {
			parentHeader = refs[len(refs)-1] // the email it answers is the last reference
		}
	}

	// Files first, outside the transaction (disk writes); unreferenced ones are cleaned up later.
	type stored struct {
		name, ctype, sum, rel string
		size                  int64
	}
	var saved []stored
	for _, f := range files {
		sum, rel, n, err := s.storeFile(bytes.NewReader(f.data))
		if err != nil {
			log.Printf("inbound: attachment %q skipped: %v", f.name, err)
			continue
		}
		saved = append(saved, stored{cleanFilename(f.name), f.ctype, sum, rel, n})
	}

	return s.tx(ctx, func(tx pgx.Tx) error {
		sender, err := s.externalUser(ctx, tx, fromAddr, fromName)
		if err != nil {
			return err
		}
		var msgID int64
		var sentAt time.Time
		if header != "" {
			err := tx.QueryRow(ctx, `SELECT id, sent_at FROM messages WHERE message_id_header = $1`, header).Scan(&msgID, &sentAt)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		if msgID == 0 {
			nm := newMessage{SenderID: sender, Subject: subject, BodyText: text, BodyHTML: htmlBody,
				HasAttachments: len(saved) > 0, MessageIDHeader: header}
			if parentHeader != "" && len(rcpts) == 1 {
				if err := s.inboundParent(ctx, tx, parentHeader, sender, rcpts[0], &nm); err != nil {
					return err
				}
			}
			if msgID, sentAt, err = s.insertMessage(ctx, tx, nm); err != nil {
				return err
			}
			for _, f := range saved {
				if _, err := tx.Exec(ctx, `INSERT INTO attachments (message_id, filename, content_type, size_bytes, sha256, storage_path)
					VALUES ($1, $2, $3, $4, $5, $6)`, msgID, f.name, f.ctype, f.size, f.sum, f.rel); err != nil {
					return err
				}
			}
		}
		snippet := Snippet(firstNonEmpty(text, stripTags(htmlBody), subject))
		for i, u := range rcpts {
			var already bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mailbox WHERE user_id = $1 AND message_id = $2)`, u, msgID).Scan(&already); err != nil {
				return err
			}
			if already {
				continue
			}
			kind := "cc"
			if i == 0 {
				kind = "to"
			}
			if _, err := tx.Exec(ctx, `INSERT INTO message_recipients (message_id, kind, user_id)
				SELECT $1, CASE WHEN $2 = 'to' AND EXISTS (SELECT 1 FROM message_recipients WHERE message_id = $1 AND kind = 'to') THEN 'cc' ELSE $2 END, $3
				WHERE NOT EXISTS (SELECT 1 FROM message_recipients WHERE message_id = $1 AND user_id = $3)`, msgID, kind, u); err != nil {
				return err
			}
			conv, err := findOrCreateDirect(ctx, tx, sender, u)
			if err != nil {
				return err
			}
			c := chat{id: conv, members: []int64{sender, u}, direct: true}
			if err := prepareChat(ctx, tx, &c, sender); err != nil {
				return err
			}
			if spam {
				c.spam = append(c.spam, u)
			}
			if err := s.deliverToChat(ctx, tx, c, msgID, sender, snippet, sentAt, len(saved) > 0); err != nil {
				return err
			}
			if err := s.notifyMessage(ctx, tx, c, msgID, sender, subject); err != nil {
				return err
			}
		}
		return nil
	})
}

// inboundParent finds the PhoneMail email an outside answer replies to: one this outsider
// received, in the recipient's chat with them. If they already answered it, the new answer
// goes under their latest answer in that chain (reply once per email still holds).
func (s *Service) inboundParent(ctx context.Context, tx pgx.Tx, parentHeader string, sender, rcpt int64, nm *newMessage) error {
	var id, root int64
	var path string
	var depth int
	err := tx.QueryRow(ctx, `SELECT m.id, m.root_id, m.path::text, m.depth FROM messages m
		WHERE m.message_id_header = $1
		  AND EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.id AND r.user_id = $2)
		  AND EXISTS (SELECT 1 FROM mailbox mb JOIN conversations c ON c.id = mb.conversation_id AND c.kind = 'direct'
		              WHERE mb.message_id = m.id AND mb.user_id = $3)`, parentHeader, sender, rcpt).
		Scan(&id, &root, &path, &depth)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // not an answer to something we know: a new thread
	}
	if err != nil {
		return err
	}
	for i := 0; i < 1000; i++ {
		var child int64
		var cpath string
		var cdepth int
		err := tx.QueryRow(ctx, `SELECT id, path::text, depth FROM messages WHERE parent_id = $1 AND sender_id = $2`, id, sender).
			Scan(&child, &cpath, &cdepth)
		if errors.Is(err, pgx.ErrNoRows) {
			break
		}
		if err != nil {
			return err
		}
		id, path, depth = child, cpath, cdepth
	}
	pid := id
	nm.ParentID, nm.RootID, nm.ParentPath, nm.ParentDepth = &pid, root, path, depth
	return nil
}

// part is a file inside an email.
type part struct {
	name, ctype string
	data        []byte
}

// extractBody returns the plain text (preferred), the HTML and the files of a MIME entity.
func extractBody(h mail.Header, body io.Reader, maxFile int64) (text, htmlBody string, files []part) {
	ctype, params, err := mime.ParseMediaType(h.Get("Content-Type"))
	if err != nil {
		ctype, params = "text/plain", map[string]string{"charset": "utf-8"}
	}
	if strings.HasPrefix(ctype, "multipart/") {
		mr := multipart.NewReader(body, params["boundary"])
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			t, hb, f := extractBody(mail.Header(p.Header), p, maxFile)
			if text == "" {
				text = t
			}
			if htmlBody == "" {
				htmlBody = hb
			}
			files = append(files, f...)
		}
		if text == "" && htmlBody != "" {
			text = htmlToText(htmlBody)
		}
		return
	}
	disp, dparams, _ := mime.ParseMediaType(h.Get("Content-Disposition"))
	if disp == "attachment" || !strings.HasPrefix(ctype, "text/") {
		name := dparams["filename"]
		if name == "" {
			name = params["name"]
		}
		if d, err := new(mime.WordDecoder).DecodeHeader(name); err == nil {
			name = d
		}
		if name == "" {
			name = "attachment"
		}
		data, err := io.ReadAll(io.LimitReader(decodeTransfer(h.Get("Content-Transfer-Encoding"), body), maxFile+1))
		if err != nil || len(data) == 0 || int64(len(data)) > maxFile {
			return "", "", nil
		}
		return "", "", []part{{name, ctype, data}}
	}
	data, _ := io.ReadAll(io.LimitReader(decodeTransfer(h.Get("Content-Transfer-Encoding"), body), maxInboundBytes))
	str := toUTF8(data, params["charset"])
	if ctype == "text/html" {
		return htmlToText(str), str, nil
	}
	return strings.ReplaceAll(str, "\r\n", "\n"), "", nil
}

func decodeTransfer(enc string, r io.Reader) io.Reader {
	switch strings.ToLower(strings.TrimSpace(enc)) {
	case "quoted-printable":
		return quotedprintable.NewReader(r)
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, &noSpace{r: r})
	}
	return r
}

// noSpace drops the line breaks inside base64 bodies.
type noSpace struct{ r io.Reader }

func (n *noSpace) Read(p []byte) (int, error) {
	for {
		k, err := n.r.Read(p)
		j := 0
		for _, c := range p[:k] {
			if c != '\r' && c != '\n' && c != ' ' && c != '\t' {
				p[j] = c
				j++
			}
		}
		if j > 0 || err != nil || k == 0 {
			return j, err
		}
	}
}

// toUTF8 keeps UTF-8 as it is; anything else is read as Latin-1 / Windows-1252 (the usual
// non-UTF-8 case), whose bytes map straight to code points.
func toUTF8(b []byte, charset string) string {
	switch strings.ToLower(strings.Trim(charset, `"' `)) {
	case "", "utf-8", "utf8", "us-ascii", "ascii":
		if utf8.Valid(b) {
			return string(b)
		}
	}
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	b, err := io.ReadAll(input)
	if err != nil {
		return nil, err
	}
	return strings.NewReader(toUTF8(b, charset)), nil
}

var (
	reBlock   = regexp.MustCompile(`(?is)<(script|style|head)[^>]*>.*?</(script|style|head)>`)
	reBreak   = regexp.MustCompile(`(?i)<(br|/p|/div|/li|/tr|/h[1-6])[^>]*>`)
	reTag     = regexp.MustCompile(`<[^>]+>`)
	reBlankLn = regexp.MustCompile(`\n{3,}`)
)

// htmlToText is the text of an HTML-only email, line breaks kept.
func htmlToText(s string) string {
	s = reBlock.ReplaceAllString(s, "")
	s = reBreak.ReplaceAllString(s, "\n")
	s = html.UnescapeString(reTag.ReplaceAllString(s, ""))
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSpace(l)
	}
	return strings.TrimSpace(reBlankLn.ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
}
