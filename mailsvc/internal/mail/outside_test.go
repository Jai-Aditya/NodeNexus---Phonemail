package mail

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// relayed is one email a fake Postfix accepted.
type relayed struct {
	from  string
	rcpts []string
	data  string
}

// fakeRelay is a tiny SMTP server standing in for the host's Postfix.
func fakeRelay(t *testing.T) (addr string, got func() []relayed) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var mu sync.Mutex
	var all []relayed
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				say := func(s string) { fmt.Fprintf(c, "%s\r\n", s) }
				say("220 fake")
				var cur relayed
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					cmd := strings.ToUpper(strings.TrimSpace(line))
					switch {
					case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
						say("250 fake")
					case strings.HasPrefix(cmd, "MAIL"):
						cur = relayed{from: angle(strings.TrimSpace(line)[5:])}
						say("250 ok")
					case strings.HasPrefix(cmd, "RCPT"):
						cur.rcpts = append(cur.rcpts, angle(strings.TrimSpace(line)[5:]))
						say("250 ok")
					case cmd == "DATA":
						say("354 go")
						var b strings.Builder
						for {
							l, err := r.ReadString('\n')
							if err != nil || l == ".\r\n" {
								break
							}
							b.WriteString(l)
						}
						cur.data = b.String()
						mu.Lock()
						all = append(all, cur)
						mu.Unlock()
						say("250 queued")
					case cmd == "QUIT":
						say("221 bye")
						return
					default:
						say("250 ok")
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String(), func() []relayed {
		mu.Lock()
		defer mu.Unlock()
		return append([]relayed(nil), all...)
	}
}

func inbound(from, to, subject, extra, body string) []byte {
	return []byte("From: " + from + "\r\nTo: " + to + "\r\nSubject: " + subject + "\r\n" + extra +
		"Content-Type: text/plain; charset=utf-8\r\n\r\n" + body + "\r\n")
}

// Email to a Gmail address goes out through Postfix; the outsider's answers come back into
// the same chat and thread; a second answer to the same email threads under the first.
func TestOutsideMail(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	_, bAddr := user(t, s, ctx, 2)

	// Without a relay, outside addresses are refused.
	_, err := s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("friend@gmail.com")}, Subject: "Hi", BodyText: "x"})
	wantCode(t, err, "external_disabled")

	relay, got := fakeRelay(t)
	s.SMTPRelay, s.SMTPHostname = relay, "mail.phonemail.com"
	r := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("Friend <Friend@Gmail.com>")}, Subject: "Hello there", BodyText: "From PhoneMail", BodyHTML: "<p><b>From</b> PhoneMail</p>"}))
	conv := r.Conversations[0]
	if !s.sendOneOutside(ctx) || s.sendOneOutside(ctx) {
		t.Fatal("want exactly one outbox email")
	}
	out := got()
	if len(out) != 1 || out[0].from != aAddr || len(out[0].rcpts) != 1 || out[0].rcpts[0] != "friend@gmail.com" {
		t.Fatalf("relayed %+v", out)
	}
	for _, want := range []string{"From: \"User 1\" <" + aAddr + ">", "To: friend@gmail.com", "Subject: Hello there", "multipart/alternative", "Message-ID: <"} {
		if !strings.Contains(out[0].data, want) {
			t.Fatalf("email lacks %q:\n%s", want, out[0].data)
		}
	}
	var status string
	s.DB.QueryRow(ctx, `SELECT status FROM outbox WHERE message_id = $1`, r.MessageID).Scan(&status)
	if status != "sent" {
		t.Fatalf("outbox status %q", status)
	}
	row := homeRow(t, s, ctx, a, conv)
	if row.Peer == nil || row.Peer.Address != "friend@gmail.com" || row.Peer.DisplayName != "Friend" {
		t.Fatalf("chat peer should be the outsider: %+v", row.Peer)
	}

	// Their answer arrives by SMTP and joins the thread.
	var header string
	s.DB.QueryRow(ctx, `SELECT message_id_header FROM messages WHERE id = $1`, r.MessageID).Scan(&header)
	must(0, s.DeliverInbound(ctx, "friend@gmail.com", []int64{a}, inbound("Friend <friend@gmail.com>", aAddr, "Re: Hello there",
		"Message-ID: <ans1@gmail.com>\r\nIn-Reply-To: "+header+"\r\n", "Got it, thanks!")))
	if homeRow(t, s, ctx, a, conv).UnreadCount != 1 {
		t.Fatal("the answer should be unread in the same chat")
	}
	thread := must(s.Thread(ctx, a, conv, r.MessageID))
	if len(thread) != 2 || thread[1].ParentID == nil || *thread[1].ParentID != r.MessageID || thread[1].Sender.Address != "friend@gmail.com" {
		t.Fatalf("answer should thread under the email: %+v", thread)
	}
	var alerts int
	s.DB.QueryRow(ctx, `SELECT count(*) FROM alert_queue WHERE user_id = $1`, a).Scan(&alerts)
	if alerts != 1 {
		t.Fatalf("A should be alerted once, got %d", alerts)
	}
	// A second answer to the same email goes under their first answer.
	must(0, s.DeliverInbound(ctx, "friend@gmail.com", []int64{a}, inbound("friend@gmail.com", aAddr, "Re: Hello there",
		"Message-ID: <ans2@gmail.com>\r\nIn-Reply-To: "+header+"\r\n", "One more thing")))
	thread = must(s.Thread(ctx, a, conv, r.MessageID))
	if len(thread) != 3 || *thread[2].ParentID != thread[1].ID {
		t.Fatalf("second answer should thread under the first: %+v", thread)
	}
	// The same email twice (e.g. one copy per recipient) is stored once.
	must(0, s.DeliverInbound(ctx, "friend@gmail.com", []int64{a}, inbound("friend@gmail.com", aAddr, "Re: Hello there",
		"Message-ID: <ans2@gmail.com>\r\nIn-Reply-To: "+header+"\r\n", "One more thing")))
	if n := len(must(s.Thread(ctx, a, conv, r.MessageID))); n != 3 {
		t.Fatalf("a repeated email must not be stored twice, got %d", n)
	}
	// Search finds an outsider's emails by their address, and emails sent to them.
	if n := len(must(s.Search(ctx, a, "from:friend@gmail.com")).Messages); n != 2 {
		t.Fatalf("from:outsider: want 2, got %d", n)
	}
	if n := len(must(s.Search(ctx, a, "to:Friend@gmail.com")).Messages); n != 1 {
		t.Fatalf("to:outsider: want 1, got %d", n)
	}

	// A's reply to the answer goes out with threading headers for their mail app.
	must(s.Reply(ctx, a, thread[1].ID, ReplyRequest{ConversationID: conv, BodyText: "You're welcome"}))
	s.sendOneOutside(ctx)
	out = got()
	if len(out) != 2 || !strings.Contains(out[1].data, "In-Reply-To: <ans1@gmail.com>") || !strings.Contains(out[1].data, "References: "+header+" <ans1@gmail.com>") {
		t.Fatalf("reply should carry In-Reply-To and References:\n%s", out[len(out)-1].data)
	}

	// Outsiders can't be in groups.
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, "friend@gmail.com"), GroupName: "Mixed"}, BodyText: "x"})
	wantCode(t, err, "outside_group")
}

// Incoming mail: forged senders are refused, spam and blocked senders go to Spam, HTML is
// cleaned, attachments are kept, and mail from outside to a new person starts a chat.
func TestInboundRules(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)

	err := s.DeliverInbound(ctx, bAddr, []int64{a}, inbound(bAddr, aAddr, "Fake", "", "pretending to be B"))
	wantCode(t, err, "bad_request")

	must(0, s.DeliverInbound(ctx, "x@spam.example", []int64{a}, inbound("x@spam.example", aAddr, "Win!", "X-Spam-Flag: YES\r\n", "prize")))
	if n := len(must(s.Folder(ctx, a, "spam", Cursor{}))); n != 1 {
		t.Fatalf("Postfix's spam verdict should put it in Spam, got %d", n)
	}
	must(s.Block(ctx, b, "pest@example.org"))
	must(0, s.DeliverInbound(ctx, "pest@example.org", []int64{b}, inbound("pest@example.org", bAddr, "Again", "", "hello")))
	if n := len(must(s.Folder(ctx, b, "spam", Cursor{}))); n != 1 {
		t.Fatalf("a blocked outsider's mail should go to Spam, got %d", n)
	}

	multipart := "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=XX\r\n"
	raw := []byte("From: Asha <asha@outlook.com>\r\nTo: " + aAddr + "\r\nSubject: =?utf-8?q?Plan_=E2=9C=93?=\r\n" + multipart + "\r\n" +
		"--XX\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hi <script>alert(1)</script><b>there</b></p>\r\n" +
		"--XX\r\nContent-Type: text/plain; name=notes.txt\r\nContent-Disposition: attachment; filename=notes.txt\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8gZmlsZQ==\r\n" +
		"--XX--\r\n")
	must(0, s.DeliverInbound(ctx, "asha@outlook.com", []int64{a}, raw))
	chats := must(s.Home(ctx, a, "all", Cursor{}))
	var got *MessageView
	for _, c := range chats {
		if c.Peer != nil && c.Peer.Address == "asha@outlook.com" {
			m := must(s.Message(ctx, a, *c.LastMessageID, &c.ConversationID))
			got = &m
		}
	}
	if got == nil {
		t.Fatal("mail from a new outsider should start a chat")
	}
	if got.Subject != "Plan ✓" || strings.Contains(got.BodyHTML, "script") || !strings.Contains(got.BodyHTML, "<b>there</b>") ||
		len(got.Attachments) != 1 || got.Attachments[0].Filename != "notes.txt" {
		t.Fatalf("unexpected message: %+v", got)
	}
}

// The SMTP conversation Postfix has with us: unknown addresses are refused at RCPT.
func TestSMTPSession(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	s.SMTPHostname = "mail.phonemail.com"
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go s.serveSMTP(ln)

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := bufio.NewReader(c)
	c.SetDeadline(time.Now().Add(10 * time.Second))
	expect := func(send, code string) {
		t.Helper()
		if send != "" {
			fmt.Fprintf(c, "%s\r\n", send)
		}
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				t.Fatalf("after %q: %v", send, err)
			}
			if len(line) > 3 && line[3] == '-' {
				continue // more lines of a multi-line answer
			}
			if !strings.HasPrefix(line, code) {
				t.Fatalf("after %q want %s, got %q", send, code, line)
			}
			return
		}
	}
	expect("", "220")
	expect("EHLO postfix", "250")
	expect("MAIL FROM:<friend@gmail.com>", "250")
	expect("RCPT TO:<0000000000@phonemail.com>", "550")
	expect("RCPT TO:<"+aAddr+">", "250")
	expect("DATA", "354")
	expect("From: friend@gmail.com\r\nSubject: Over SMTP\r\n\r\n..a dot-stuffed line\r\n.", "250")
	expect("QUIT", "221")
	chats := must(s.Home(ctx, a, "all", Cursor{}))
	if len(chats) != 1 || chats[0].Snippet != ".a dot-stuffed line" {
		t.Fatalf("delivered over SMTP: %+v", chats)
	}
}

// Addresses on an earlier domain (legacy.example) still reach the same people.
func TestLegacyDomain(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	local := strings.Split(aAddr, "@")[0]
	if _, err := s.resolveAddress(ctx, s.DB, local+"@legacy.example"); err != ErrExternalMail {
		t.Fatalf("without the setting it's an outside address, got %v", err)
	}
	s.LegacyDomains = map[string]bool{"legacy.example": true}
	if id := must(s.resolveAddress(ctx, s.DB, local+"@Legacy.Example")); id != a {
		t.Fatalf("old address should reach A, got %d", id)
	}
	must(0, s.DeliverInbound(ctx, "friend@gmail.com", []int64{a}, inbound("friend@gmail.com", local+"@legacy.example", "Old address", "", "still works")))
	if n := len(must(s.Home(ctx, a, "all", Cursor{}))); n != 1 {
		t.Fatalf("mail to the old address should arrive, got %d chats", n)
	}
}

// An ordinary mailbox on our own domain (not a PhoneMail account) is written to through Postfix.
func TestOtherMailbox(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	_, err := s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("office@phonemail.com")}, BodyText: "x"})
	wantCode(t, err, "not_found")
	relay, got := fakeRelay(t)
	s.SMTPRelay = relay
	s.OtherMailboxes = map[string]bool{"office@phonemail.com": true}
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("Office@PhoneMail.com")}, Subject: "Hi", BodyText: "to Dovecot"}))
	s.sendOneOutside(ctx)
	if out := got(); len(out) != 1 || out[0].rcpts[0] != "office@phonemail.com" {
		t.Fatalf("should go to Postfix: %+v", out)
	}
}
