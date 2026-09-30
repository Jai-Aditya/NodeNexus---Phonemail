package mail

// Integration tests against a real PostgreSQL. They WIPE the database given in
// TEST_DATABASE_URL, so point it at a throwaway database, e.g.
//   TEST_DATABASE_URL=postgres://phonemail:phonemail@localhost:5432/phonemail_test go test ./...

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"phonemail/mailsvc/internal/db"
)

func setup(t *testing.T) (*Service, context.Context) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return &Service{DB: pool, Domain: "phonemail.com", AttachmentDir: t.TempDir(), MaxAttachment: 1 << 20}, ctx
}

// user creates a user with phone +9198765432NN and returns (id, address).
func user(t *testing.T, s *Service, ctx context.Context, n int) (int64, string) {
	t.Helper()
	phone := fmt.Sprintf("+91987654%04d", n)
	var id int64
	if err := s.DB.QueryRow(ctx, `INSERT INTO users (phone, display_name) VALUES ($1, $2) RETURNING id`,
		phone, fmt.Sprintf("User %d", n)).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id, phone[3:] + "@phonemail.com"
}

func to(addrs ...string) ToList {
	out := ToList{}
	for _, a := range addrs {
		out = append(out, Recipient{Address: a})
	}
	return out
}
func toGroup(id int64) ToList { return ToList{{GroupID: id}} }

// must returns v, failing the test (by panicking) if err is set.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var me *Error
	if !errors.As(err, &me) || me.Code != code {
		t.Fatalf("want error %q, got %v", code, err)
	}
}

func homeRow(t *testing.T, s *Service, ctx context.Context, user, conv int64) ChatSummary {
	t.Helper()
	for _, c := range must(s.Home(ctx, user, "all", Cursor{})) {
		if c.ConversationID == conv {
			return c
		}
	}
	t.Fatalf("chat %d not on user %d's Home", conv, user)
	return ChatSummary{}
}

// 2. A->B then B->A land in one chat; both copies are stored once.
func TestDirectChatReuse(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)

	r1 := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: "Hi", BodyText: "hello"}))
	r2 := must(s.Send(ctx, b, SendRequest{Recipients: Recipients{To: to(aAddr)}, Subject: "Hey", BodyText: "back"}))
	if r1.Conversations[0] != r2.Conversations[0] {
		t.Fatalf("A->B and B->A went to different chats: %v vs %v", r1.Conversations, r2.Conversations)
	}
	// Bare phone numbers and +91 numbers resolve too.
	r3 := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("+91 98765 40002")}, BodyText: "by number"}))
	if r3.Conversations[0] != r1.Conversations[0] {
		t.Fatal("sending by phone number used a different chat")
	}
	var n int
	s.DB.QueryRow(ctx, `SELECT count(*) FROM messages`).Scan(&n)
	if n != 3 {
		t.Fatalf("want 3 stored messages, got %d", n)
	}
	if u := homeRow(t, s, ctx, b, r1.Conversations[0]).UnreadCount; u != 2 {
		t.Fatalf("B should have 2 unread, got %d", u)
	}
	if u := homeRow(t, s, ctx, a, r1.Conversations[0]).UnreadCount; u != 1 {
		t.Fatalf("A should have 1 unread, got %d", u)
	}
}

// 3. Same members + same name reuses a group; a different name makes a second group.
func TestGroupIdentity(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	_, bAddr := user(t, s, ctx, 2)
	_, cAddr := user(t, s, ctx, 3)
	members := []Recipient{{Address: bAddr}, {Address: cAddr}}

	g1 := must(s.CreateGroup(ctx, a, "Committee", members))
	g2 := must(s.CreateGroup(ctx, a, "Committee", members))
	g3 := must(s.CreateGroup(ctx, a, "Treasury", members))
	if !g1.Created || g2.Created || g1.ConversationID != g2.ConversationID {
		t.Fatal("same members + same name should reuse the group")
	}
	if g3.ConversationID == g1.ConversationID {
		t.Fatal("different name should create a second group")
	}
	_, err := s.CreateGroup(ctx, a, "   ", members)
	wantCode(t, err, "bad_request")
	if g1.Members[0].Role != "admin" || g1.Members[0].UserID != a {
		t.Fatal("creator should be the admin")
	}
}

// 4. To is required; Gcc isn't a send field; non-members can't send to a group.
func TestRecipientRules(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	_, cAddr := user(t, s, ctx, 3)
	outsider, _ := user(t, s, ctx, 4)

	_, err := s.Send(ctx, a, SendRequest{Recipients: Recipients{Cc: []Recipient{{Address: bAddr}}}, BodyText: "x"})
	wantCode(t, err, "bad_request")
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(aAddr)}, BodyText: "x"})
	wantCode(t, err, "bad_request")
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("someone@gmail.com")}, BodyText: "x"})
	wantCode(t, err, "external_disabled")
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("nobody@phonemail.com")}, BodyText: "x"})
	wantCode(t, err, "not_found")

	g := must(s.CreateGroup(ctx, a, "Friends", []Recipient{{Address: bAddr}, {Address: cAddr}}))
	_, err = s.Send(ctx, outsider, SendRequest{Recipients: Recipients{To: toGroup(g.ConversationID)}, BodyText: "x"})
	wantCode(t, err, "forbidden")
	res := must(s.Send(ctx, b, SendRequest{Recipients: Recipients{To: toGroup(g.ConversationID)}, BodyText: "hi all"}))
	if len(res.Conversations) != 1 || res.Conversations[0] != g.ConversationID {
		t.Fatal("a group message should land in the group chat only")
	}
}

// Brief: two or more people in To start a group. It needs a name; an existing group is
// then reached by its name (in To, Cc or Bcc), and one-to-one mail stays one-to-one.
func TestHomeComposeStartsGroup(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	d, dAddr := user(t, s, ctx, 4)

	// No name: the client is asked for one.
	_, err := s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, cAddr)}, BodyText: "Goa?"})
	wantCode(t, err, "group_name_required")

	first := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, cAddr), GroupName: " Goa   crew "}, Subject: "Trip", BodyText: "Goa?"}))
	gid := first.Conversations[0]
	g := must(s.GetGroup(ctx, b, gid))
	if g.Name != "Goa crew" || len(g.Members) != 3 {
		t.Fatalf("unexpected group %q with %d members", g.Name, len(g.Members))
	}
	for _, m := range g.Members {
		if want := map[bool]string{true: "admin", false: "member"}[m.UserID == a]; m.Role != want {
			t.Fatalf("user %d should be %s, is %s", m.UserID, want, m.Role)
		}
	}
	for _, u := range []int64{b, c} {
		if homeRow(t, s, ctx, u, gid).UnreadCount != 1 {
			t.Fatalf("user %d should have 1 unread in the group", u)
		}
	}
	// The message has exactly one To: the group (spec rule kept).
	if rs := must(s.Message(ctx, b, first.MessageID, nil)).Recipients; len(rs) != 1 || rs[0].GroupID != gid {
		t.Fatalf("the To should be the group, got %+v", rs)
	}

	// The same people and name again is refused: use the group's name instead.
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(cAddr, bAddr), GroupName: "Goa crew"}, BodyText: "x"})
	wantCode(t, err, "group_exists")
	// Reaching it by name: in To (any letter case, as a field or typed as an address) and in Cc.
	byName := must(s.Send(ctx, b, SendRequest{Recipients: Recipients{To: ToList{{Group: "goa CREW"}}}, BodyText: "by name"}))
	typed := must(s.Send(ctx, c, SendRequest{Recipients: Recipients{To: to("Goa crew")}, BodyText: "typed"}))
	if byName.Conversations[0] != gid || typed.Conversations[0] != gid {
		t.Fatal("the group name should reach the group")
	}
	cc := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(dAddr), Cc: []Recipient{{Group: "Goa crew"}}}, BodyText: "fyi"}))
	if len(cc.Conversations) != 2 || !containsID(cc.Conversations, gid) {
		t.Fatalf("Cc to the group should reach the group chat too, got %v", cc.Conversations)
	}
	// D isn't in the group, so the name means nothing to D.
	_, err = s.Send(ctx, d, SendRequest{Recipients: Recipients{To: ToList{{Group: "Goa crew"}}}, BodyText: "x"})
	wantCode(t, err, "not_found")

	// Same people, a new name: a second group. A name the creator already uses: refused.
	second := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, cAddr), GroupName: "Budget"}, BodyText: "money"}))
	if second.Conversations[0] == gid {
		t.Fatal("a new name should make a new group")
	}
	// The same name with different people is a different group; then the name alone is
	// ambiguous for whoever is in both, and they pick the group from their list.
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, dAddr), GroupName: "GOA crew"}, BodyText: "x"}))
	_, err = s.Send(ctx, b, SendRequest{Recipients: Recipients{To: ToList{{Group: "Goa crew"}}}, BodyText: "x"})
	wantCode(t, err, "ambiguous_group")

	// Later one-to-one mail stays in the direct chat; the same person twice is one-to-one.
	direct := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "just you"}))
	dup := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, "+91 98765 40002")}, BodyText: "dup"}))
	var kind string
	s.DB.QueryRow(ctx, `SELECT kind FROM conversations WHERE id = $1`, direct.Conversations[0]).Scan(&kind)
	if kind != "direct" || dup.Conversations[0] != direct.Conversations[0] {
		t.Fatal("mail to one person must use the direct chat")
	}

	// Rules: no groups mixed with people, no self, group_name needs 2+ people.
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: append(to(bAddr), Recipient{GroupID: gid}), GroupName: "X"}, BodyText: "x"})
	wantCode(t, err, "bad_request")
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, "9876540001"), GroupName: "X"}, BodyText: "x"})
	wantCode(t, err, "bad_request")
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr), GroupName: "Solo"}, BodyText: "x"})
	wantCode(t, err, "bad_request")
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: ToList{{Address: bAddr, Group: "Goa crew"}}}, BodyText: "x"})
	wantCode(t, err, "bad_request")
}

// Optional spec lines: created, added, removed, left, admin changes, from each viewer's side.
func TestGroupEvents(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	d, dAddr := user(t, s, ctx, 4)

	g := must(s.CreateGroup(ctx, a, "Team", []Recipient{{Address: bAddr}, {Address: cAddr}}))
	gid := g.ConversationID
	must(s.AddMembers(ctx, a, gid, []Recipient{{Address: dAddr}}))
	if err := s.SetRole(ctx, a, gid, b, "admin"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetRole(ctx, a, gid, b, "admin"); err != nil { // no change: no line
		t.Fatal(err)
	}
	if err := s.SetRole(ctx, b, gid, b, "member"); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveMember(ctx, a, gid, c); err != nil {
		t.Fatal(err)
	}
	if err := s.LeaveGroup(ctx, a, gid); err != nil { // last admin leaves: B (longest-standing) is promoted
		t.Fatal(err)
	}

	texts := func(viewer int64) string {
		evs := must(s.ChatEvents(ctx, viewer, gid, nil, nil))
		var out []string
		for i := len(evs) - 1; i >= 0; i-- { // oldest first
			out = append(out, evs[i].Text)
		}
		return strings.Join(out, " | ")
	}
	want := "User 1 created the group | User 1 added User 4 | User 1 made you an admin | " +
		"You're no longer an admin | User 1 removed User 3 | User 1 left | You're now an admin"
	if got := texts(b); got != want {
		t.Fatalf("B sees:\n%s\nwant:\n%s", got, want)
	}
	// D joined after the group was created: sees only from the moment they were added.
	if got := texts(d); !strings.HasPrefix(got, "User 1 added you | User 1 made User 2 an admin") || strings.Contains(got, "created") {
		t.Fatalf("D sees %q", got)
	}
	// C was removed: sees up to and including their removal, nothing after.
	if got := texts(c); !strings.HasSuffix(got, "User 1 removed you") {
		t.Fatalf("C sees %q", got)
	}
	// Events come with the chat page, in the page's time window.
	var n int
	s.DB.QueryRow(ctx, `SELECT count(*) FROM conversation_events WHERE conversation_id = $1`, gid).Scan(&n)
	if n != 7 {
		t.Fatalf("want 7 activity lines stored, got %d", n)
	}
	_ = a
}

// aAddr returns a user's main address.
func aAddr(t *testing.T, s *Service, ctx context.Context, id int64) string {
	t.Helper()
	var local string
	if err := s.DB.QueryRow(ctx, `SELECT phone_local FROM users WHERE id = $1`, id).Scan(&local); err != nil {
		t.Fatal(err)
	}
	return s.AddressOf(local)
}

// To in JSON: a single object (as before) or an array of people.
func TestToListJSON(t *testing.T) {
	var r Recipients
	if err := json.Unmarshal([]byte(`{"to":{"address":"9876500001"}}`), &r); err != nil || len(r.To) != 1 {
		t.Fatalf("object form: %v %v", r.To, err)
	}
	if err := json.Unmarshal([]byte(`{"to":[{"address":"1"},{"address":"2"}],"group_name":"G"}`), &r); err != nil ||
		len(r.To) != 2 || r.GroupName != "G" {
		t.Fatalf("array form: %v %v", r, err)
	}
	out := must(json.Marshal(Recipients{To: to("x")}))
	if string(out) != `{"to":{"address":"x"}}` {
		t.Fatalf("a single To should stay an object, got %s", out)
	}
}

// 5. Cc and Bcc: each person gets it in their own direct chat; Bcc is hidden from others.
func TestCcAndBcc(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	d, dAddr := user(t, s, ctx, 4)

	res := must(s.Send(ctx, a, SendRequest{
		Recipients: Recipients{To: to(bAddr), Cc: []Recipient{{Address: cAddr}}, Bcc: []Recipient{{Address: dAddr}}},
		Subject:    "Plan", BodyText: "meeting at 5",
	}))
	if len(res.Conversations) != 3 {
		t.Fatalf("want 3 direct chats, got %v", res.Conversations)
	}
	var n int
	s.DB.QueryRow(ctx, `SELECT count(*) FROM messages`).Scan(&n)
	if n != 1 {
		t.Fatalf("the message must be stored once, got %d rows", n)
	}
	kinds := func(viewer int64) string {
		m := must(s.Message(ctx, viewer, res.MessageID, nil))
		var ks []string
		for _, r := range m.Recipients {
			ks = append(ks, r.Kind)
		}
		return strings.Join(ks, ",")
	}
	if got := kinds(a); got != "to,cc,bcc" {
		t.Fatalf("sender sees %q", got)
	}
	if got := kinds(b); got != "to,cc" {
		t.Fatalf("To recipient sees %q, Bcc should be hidden", got)
	}
	if got := kinds(c); got != "to,cc" {
		t.Fatalf("Cc recipient sees %q", got)
	}
	if got := kinds(d); got != "to,cc,bcc" {
		t.Fatalf("Bcc recipient should see only themselves as bcc, got %q", got)
	}
	// Sender has one pointer per chat.
	s.DB.QueryRow(ctx, `SELECT count(*) FROM mailbox WHERE user_id = $1`, a).Scan(&n)
	if n != 3 {
		t.Fatalf("sender should have 3 pointers, got %d", n)
	}
	_ = b
	_ = c
	_ = d
}

// 6. Reply once per person; different group members can each reply.
// 7. Thread path: a reply to a reply gets the right root, path and depth.
func TestRepliesAndThreads(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	g := must(s.CreateGroup(ctx, a, "Trip", []Recipient{{Address: bAddr}, {Address: cAddr}}))
	gid := g.ConversationID

	root := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: toGroup(gid)}, Subject: "Trip plan", BodyText: "Goa?"}))
	rb := must(s.Reply(ctx, b, root.MessageID, ReplyRequest{ConversationID: gid, BodyText: "Yes"}))
	_, err := s.Reply(ctx, b, root.MessageID, ReplyRequest{ConversationID: gid, BodyText: "Again"})
	if !errors.Is(err, ErrAlreadyReplied) {
		t.Fatalf("second reply by the same person should fail, got %v", err)
	}
	rc := must(s.Reply(ctx, c, root.MessageID, ReplyRequest{ConversationID: gid, BodyText: "Me too"}))
	rab := must(s.Reply(ctx, a, rb.MessageID, ReplyRequest{ConversationID: gid, BodyText: "Great"}))

	thread := must(s.Thread(ctx, a, gid, root.MessageID))
	var order []int64
	for _, m := range thread {
		order = append(order, m.ID)
		if m.RootID != root.MessageID {
			t.Fatal("wrong root")
		}
	}
	want := []int64{root.MessageID, rb.MessageID, rab.MessageID, rc.MessageID}
	if fmt.Sprint(order) != fmt.Sprint(want) {
		t.Fatalf("thread order %v, want %v", order, want)
	}
	if thread[2].Depth != 2 || thread[1].Subject != "Re: Trip plan" {
		t.Fatalf("depth/subject wrong: %+v", thread[2])
	}
	mv := must(s.Message(ctx, b, root.MessageID, &gid))
	if !mv.IsReplied {
		t.Fatal("replier's pointer to the parent should be marked replied")
	}
}

// 8. New members get new threads, but not replies to older threads.
// 9. When the last admin leaves, the longest-standing member becomes admin.
func TestGroupMembershipVisibility(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	d, dAddr := user(t, s, ctx, 4)
	g := must(s.CreateGroup(ctx, a, "Block B", []Recipient{{Address: bAddr}}))
	gid := g.ConversationID

	old := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: toGroup(gid)}, BodyText: "old thread"}))
	_, err := s.AddMembers(ctx, b, gid, []Recipient{{Address: dAddr}})
	wantCode(t, err, "forbidden") // only admins add
	must(s.AddMembers(ctx, a, gid, []Recipient{{Address: dAddr}}))

	oldReply := must(s.Reply(ctx, b, old.MessageID, ReplyRequest{ConversationID: gid, BodyText: "reply to old"}))
	fresh := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: toGroup(gid)}, BodyText: "new thread"}))
	freshReply := must(s.Reply(ctx, b, fresh.MessageID, ReplyRequest{ConversationID: gid, BodyText: "reply to new"}))

	seen := map[int64]bool{}
	for _, m := range must(s.ChatMessages(ctx, d, gid, Cursor{})) {
		seen[m.ID] = true
	}
	if seen[old.MessageID] || seen[oldReply.MessageID] {
		t.Fatal("new member must not see older threads or replies to them")
	}
	if !seen[fresh.MessageID] || !seen[freshReply.MessageID] {
		t.Fatal("new member should see threads started after joining")
	}

	// A leaves: B (longest-standing) becomes admin; D doesn't.
	if err := s.LeaveGroup(ctx, a, gid); err != nil {
		t.Fatal(err)
	}
	g2 := must(s.GetGroup(ctx, b, gid))
	for _, m := range g2.Members {
		if (m.UserID == b) != (m.Role == "admin") {
			t.Fatalf("after the admin left, only B should be admin: %+v", g2.Members)
		}
	}
	// A kept what they received but gets nothing new, and can't send.
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: toGroup(gid)}, BodyText: "x"})
	wantCode(t, err, "forbidden")
	later := must(s.Send(ctx, b, SendRequest{Recipients: Recipients{To: toGroup(gid)}, BodyText: "after A left"}))
	if _, err := s.Message(ctx, a, later.MessageID, nil); err == nil {
		t.Fatal("a member who left must not receive new messages")
	}
	must(s.Message(ctx, a, old.MessageID, nil))
	_ = d
}

// Membership changes that would duplicate another group (same members + name) are refused.
func TestGroupClash(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	_, bAddr := user(t, s, ctx, 2)
	_, cAddr := user(t, s, ctx, 3)
	d, _ := user(t, s, ctx, 4)
	must(s.CreateGroup(ctx, a, "Same", []Recipient{{Address: bAddr}, {Address: cAddr}}))
	// Same name, different members: allowed. Then D adds A and leaves, which would
	// leave exactly A, B, C in a second "Same": refused.
	g2 := must(s.CreateGroup(ctx, d, "Same", []Recipient{{Address: bAddr}, {Address: cAddr}}))
	must(s.AddMembers(ctx, d, g2.ConversationID, []Recipient{{Address: aAddr}}))
	if err := s.LeaveGroup(ctx, d, g2.ConversationID); !errors.Is(err, ErrGroupClash) {
		t.Fatalf("want group clash, got %v", err)
	}
}

// 10. Counters: unread and favourites go up and down; filters use them.
func TestCountersAndFilters(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	r1 := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "one"}))
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "two"}))
	conv := r1.Conversations[0]

	if len(must(s.Home(ctx, b, "unread", Cursor{}))) != 1 {
		t.Fatal("chat should show under Unread")
	}
	fav := true
	if err := s.UpdatePointer(ctx, b, r1.MessageID, &conv, PointerPatch{IsFavourite: &fav}); err != nil {
		t.Fatal(err)
	}
	if homeRow(t, s, ctx, b, conv).FavouriteCount != 1 || len(must(s.Home(ctx, b, "favorites", Cursor{}))) != 1 {
		t.Fatal("favourite should count and show under Favorites")
	}
	must(s.ChatMessages(ctx, b, conv, Cursor{})) // opening marks read
	if homeRow(t, s, ctx, b, conv).UnreadCount != 0 || len(must(s.Home(ctx, b, "unread", Cursor{}))) != 0 {
		t.Fatal("opening the chat should clear unread")
	}
	trash := "trash"
	if err := s.UpdatePointer(ctx, b, r1.MessageID, &conv, PointerPatch{Folder: &trash}); err != nil {
		t.Fatal(err)
	}
	row := homeRow(t, s, ctx, b, conv)
	if row.FavouriteCount != 0 || row.Snippet != "two" {
		t.Fatalf("trashing should update counters: %+v", row)
	}
	if n := len(must(s.Folder(ctx, b, "trash", Cursor{}))); n != 1 {
		t.Fatalf("trash should have 1 item, got %d", n)
	}
	// A still has the message; B empties trash; cleanup keeps it (A still points to it).
	must(s.EmptyTrash(ctx, b))
	if err := s.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	must(s.Message(ctx, a, r1.MessageID, nil))
}

// Drafts: autosave, attachments, send consumes the draft; compose inside a chat locks To.
func TestDraftsAndAttachments(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	d := must(s.SaveDraft(ctx, a, nil, DraftInput{Recipients: Recipients{To: to(bAddr)}, Subject: "Doc", BodyText: "see file"}))
	must(s.AddDraftAttachment(ctx, a, d.ID, "../../etc/notes.txt", "text/plain", strings.NewReader("hello file")))
	if _, err := s.AddDraftAttachment(ctx, b, d.ID, "x.txt", "", strings.NewReader("x")); err == nil {
		t.Fatal("others must not attach to my draft")
	}
	res := must(s.SendDraft(ctx, a, d.ID))
	if _, err := s.GetDraft(ctx, a, d.ID); err == nil {
		t.Fatal("sending should delete the draft")
	}
	m := must(s.Message(ctx, b, res.MessageID, nil))
	if !m.HasAttachments || len(m.Attachments) != 1 || m.Attachments[0].Filename != "notes.txt" {
		t.Fatalf("recipient should see the attachment: %+v", m.Attachments)
	}
	info, f, err := s.OpenAttachment(ctx, b, m.Attachments[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if info.SizeBytes != 10 {
		t.Fatalf("size %d", info.SizeBytes)
	}
	if homeRow(t, s, ctx, b, res.Conversations[0]).HasAttachments != true {
		t.Fatal("chat should show under Attachments")
	}

	// New email inside the chat: To is locked to the other person.
	conv := res.Conversations[0]
	r2 := must(s.Send(ctx, b, SendRequest{ConversationID: &conv, Subject: "Thanks", BodyText: "got it"}))
	if r2.Conversations[0] != conv {
		t.Fatal("compose inside a chat should stay in that chat")
	}

	// Search finds it by a word prefix, and finds the person by number.
	sr := must(s.Search(ctx, a, "than"))
	if len(sr.Messages) != 1 || sr.Messages[0].ID != r2.MessageID {
		t.Fatalf("search should find the message: %+v", sr.Messages)
	}
	sr = must(s.Search(ctx, a, "9876540002"))
	if len(sr.People) != 1 || sr.People[0].UserID != b || sr.People[0].ConversationID == nil {
		t.Fatalf("search by number should find B and the chat: %+v", sr.People)
	}
}

// Aliases resolve to the same user and chat.
func TestAliases(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	if _, err := s.DB.Exec(ctx, `INSERT INTO aliases (alias, user_id) VALUES ('kavya@phonemail.com', $1)`, b); err != nil {
		t.Fatal(err)
	}
	r1 := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "1"}))
	r2 := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("Kavya@PhoneMail.com")}, BodyText: "2"}))
	r3 := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to("kavya")}, BodyText: "3"}))
	if r1.Conversations[0] != r2.Conversations[0] || r2.Conversations[0] != r3.Conversations[0] {
		t.Fatal("an alias must reach the same chat as the phone address")
	}
}

// Racing first messages must still produce one direct chat; racing replies only one reply.
func TestConcurrency(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)

	type out struct {
		res SendResult
		err error
	}
	ch := make(chan out, 20)
	for i := 0; i < 10; i++ {
		go func() {
			r, err := s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "a"})
			ch <- out{r, err}
		}()
		go func() {
			r, err := s.Send(ctx, b, SendRequest{Recipients: Recipients{To: to(aAddr)}, BodyText: "b"})
			ch <- out{r, err}
		}()
	}
	convs := map[int64]bool{}
	var first int64
	for i := 0; i < 20; i++ {
		o := <-ch
		if o.err != nil {
			t.Fatal(o.err)
		}
		convs[o.res.Conversations[0]] = true
		first = o.res.MessageID
	}
	if len(convs) != 1 {
		t.Fatalf("racing sends created %d chats", len(convs))
	}
	var conv int64
	for c := range convs {
		conv = c
	}
	errs := make(chan error, 5)
	for i := 0; i < 5; i++ {
		go func() {
			_, err := s.Reply(ctx, b, first, ReplyRequest{ConversationID: conv, BodyText: "r"})
			errs <- err
		}()
	}
	ok := 0
	for i := 0; i < 5; i++ {
		if err := <-errs; err == nil {
			ok++
		} else if !errors.Is(err, ErrAlreadyReplied) {
			t.Fatal(err)
		}
	}
	if ok != 1 {
		t.Fatalf("want exactly 1 successful reply, got %d", ok)
	}
}

// When everyone has deleted a message for good, cleanup removes it and its file.
func TestCleanupRemovesOrphans(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	d := must(s.SaveDraft(ctx, a, nil, DraftInput{Recipients: Recipients{To: to(bAddr)}, BodyText: "bye"}))
	must(s.AddDraftAttachment(ctx, a, d.ID, "f.txt", "text/plain", strings.NewReader("data")))
	res := must(s.SendDraft(ctx, a, d.ID))
	trash := "trash"
	for _, u := range []int64{a, b} {
		if err := s.UpdatePointer(ctx, u, res.MessageID, nil, PointerPatch{Folder: &trash}); err != nil {
			t.Fatal(err)
		}
		must(s.EmptyTrash(ctx, u))
	}
	if err := s.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	s.DB.QueryRow(ctx, `SELECT count(*) FROM messages`).Scan(&n)
	if n != 0 {
		t.Fatalf("orphan message should be deleted, %d left", n)
	}
	entries, _ := os.ReadDir(s.AttachmentDir)
	for _, e := range entries {
		sub, _ := os.ReadDir(s.AttachmentDir + "/" + e.Name())
		if len(sub) > 0 {
			t.Fatal("attachment file should be deleted")
		}
	}
}

// Content is checked and HTML cleaned before it is stored.
func TestContentRules(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)

	res := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)},
		Subject:  "  Hello\n  there ",
		BodyHTML: `<p onclick="steal()">Hi <b>Asha</b></p><script>steal()</script><a href="javascript:steal()">x</a><a href="https://example.com">site</a>`,
	}))
	m := must(s.Message(ctx, b, res.MessageID, nil))
	if m.Subject != "Hello there" {
		t.Fatalf("subject should be one trimmed line, got %q", m.Subject)
	}
	for _, bad := range []string{"<script", "onclick", "javascript:"} {
		if strings.Contains(m.BodyHTML, bad) {
			t.Fatalf("stored HTML still contains %q: %s", bad, m.BodyHTML)
		}
	}
	if !strings.Contains(m.BodyHTML, "<b>Asha</b>") || !strings.Contains(m.BodyHTML, `rel="nofollow noopener"`) {
		t.Fatalf("safe formatting and links should stay: %s", m.BodyHTML)
	}

	_, err := s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: strings.Repeat("x", MaxSubjectChars+1), BodyText: "x"})
	wantCode(t, err, "bad_request")
	_, err = s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: strings.Repeat("x", MaxBodyText+1)})
	wantCode(t, err, "bad_request")
	d := must(s.SaveDraft(ctx, a, nil, DraftInput{BodyHTML: `<img src=x onerror="steal()">`}))
	if strings.Contains(d.BodyHTML, "onerror") {
		t.Fatalf("drafts are cleaned too: %s", d.BodyHTML)
	}
}

// Limits: recipients per message, drafts, files per draft, storage, group size.
func TestLimits(t *testing.T) {
	s, ctx := setup(t)
	s.Limits = Limits{MaxRecipients: 2, MaxDrafts: 2, MaxDraftFiles: 1, MaxUserStorage: 10, MaxGroupMembers: 3}
	a, _ := user(t, s, ctx, 1)
	_, bAddr := user(t, s, ctx, 2)
	_, cAddr := user(t, s, ctx, 3)
	_, dAddr := user(t, s, ctx, 4)

	_, err := s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr), Cc: []Recipient{{Address: cAddr}, {Address: dAddr}}}, BodyText: "x"})
	wantCode(t, err, "bad_request")

	d1 := must(s.SaveDraft(ctx, a, nil, DraftInput{BodyText: "1"}))
	must(s.SaveDraft(ctx, a, nil, DraftInput{BodyText: "2"}))
	_, err = s.SaveDraft(ctx, a, nil, DraftInput{BodyText: "3"})
	wantCode(t, err, "too_many_drafts")
	must(s.SaveDraft(ctx, a, &d1.ID, DraftInput{BodyText: "1 edited"})) // editing is always fine

	_, err = s.AddDraftAttachment(ctx, a, d1.ID, "big.txt", "text/plain", strings.NewReader("more than ten bytes"))
	wantCode(t, err, "storage_full")
	must(s.AddDraftAttachment(ctx, a, d1.ID, "a.txt", "text/plain", strings.NewReader("12345")))
	_, err = s.AddDraftAttachment(ctx, a, d1.ID, "b.txt", "text/plain", strings.NewReader("1"))
	wantCode(t, err, "too_many_files")
	if used := must(s.StorageUsed(ctx, a)); used != 5 {
		t.Fatalf("storage used should be 5 bytes, got %d", used)
	}

	g := must(s.CreateGroup(ctx, a, "Three", []Recipient{{Address: bAddr}, {Address: cAddr}}))
	_, err = s.AddMembers(ctx, a, g.ConversationID, []Recipient{{Address: dAddr}})
	wantCode(t, err, "bad_request")
}

// Search looks only in the searcher's own mailbox, and ignores one-letter words.
func TestSearchScope(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: "Budget review", BodyText: "numbers"}))
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr), Cc: []Recipient{{Address: cAddr}}}, Subject: "Budget plan", BodyText: "x"}))

	if got := must(s.Search(ctx, b, "budg")).Messages; len(got) != 2 {
		t.Fatalf("B should find both, got %d", len(got))
	}
	if got := must(s.Search(ctx, c, "budg")).Messages; len(got) != 1 || got[0].Subject != "Budget plan" {
		t.Fatalf("C should find only the message C received, got %+v", got)
	}
	if got := must(s.Search(ctx, b, "b")).Messages; len(got) != 0 {
		t.Fatalf("one-letter searches should not match messages, got %d", len(got))
	}
	// One message in two of A's chats is listed once.
	if got := must(s.Search(ctx, a, "plan")).Messages; len(got) != 1 {
		t.Fatalf("a message in two chats should be listed once, got %d", len(got))
	}
}

// Reading and starring adjust Home counters without recounting; reopening a read chat writes nothing.
func TestCounterDeltas(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	r1 := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "1"}))
	r2 := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "2"}))
	conv := r1.Conversations[0]
	yes, no := true, false
	check := func(unread, fav int) {
		t.Helper()
		row := homeRow(t, s, ctx, b, conv)
		if row.UnreadCount != unread || row.FavouriteCount != fav {
			t.Fatalf("want unread %d fav %d, got %d %d", unread, fav, row.UnreadCount, row.FavouriteCount)
		}
	}
	check(2, 0)
	must(0, s.UpdatePointer(ctx, b, r1.MessageID, &conv, PointerPatch{IsRead: &yes}))
	must(0, s.UpdatePointer(ctx, b, r1.MessageID, &conv, PointerPatch{IsRead: &yes})) // no change twice
	check(1, 0)
	must(0, s.UpdatePointer(ctx, b, r2.MessageID, &conv, PointerPatch{IsFavourite: &yes}))
	check(1, 1)
	trash, inbox := "trash", "inbox"
	must(0, s.UpdatePointer(ctx, b, r2.MessageID, &conv, PointerPatch{Folder: &trash}))
	check(0, 0)
	must(0, s.UpdatePointer(ctx, b, r2.MessageID, &conv, PointerPatch{Folder: &inbox}))
	check(1, 1)
	must(0, s.UpdatePointer(ctx, b, r1.MessageID, &conv, PointerPatch{IsRead: &no, IsFavourite: &no}))
	check(2, 1)
	must(0, s.MarkChatRead(ctx, b, conv))
	check(0, 1)
	var xmin1, xmin2 string
	s.DB.QueryRow(ctx, `SELECT xmin::text FROM user_conversations WHERE user_id = $1 AND conversation_id = $2`, b, conv).Scan(&xmin1)
	must(0, s.MarkChatRead(ctx, b, conv))
	s.DB.QueryRow(ctx, `SELECT xmin::text FROM user_conversations WHERE user_id = $1 AND conversation_id = $2`, b, conv).Scan(&xmin2)
	if xmin1 != xmin2 {
		t.Fatal("reopening a chat with nothing unread should not write")
	}
}

// Lists show at most PreviewChars of a message; the single-message view shows it all.
func TestListPreview(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	long := strings.Repeat("word ", 60) // 300 characters
	send := func(text, html string) int64 {
		return must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: text, BodyHTML: html})).MessageID
	}
	short := send("Short one\nwith a line break", "<p>Short <b>one</b></p>")
	plain := send(long, "")
	htmlOnly := send("", "<p>"+long+"</p>")
	bigHTML := send("Short text", "<p>"+strings.Repeat("<b>x</b> ", 600)+"</p>") // > 4 KB of HTML

	conv := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "last"})).Conversations[0]
	byID := map[int64]MessageView{}
	for _, m := range must(s.ChatMessages(ctx, b, conv, Cursor{})) {
		byID[m.ID] = m
	}

	if m := byID[short]; m.Truncated || m.BodyText != "Short one\nwith a line break" || m.BodyHTML == "" {
		t.Fatalf("a short message is listed whole, with its formatting: %+v", m)
	}
	for name, id := range map[string]int64{"plain": plain, "html-only": htmlOnly} {
		m := byID[id]
		if !m.Truncated || m.BodyHTML != "" || !strings.HasSuffix(m.BodyText, "…") ||
			utf8.RuneCountInString(m.BodyText) > PreviewChars+1 || strings.HasSuffix(m.BodyText, " …") {
			t.Fatalf("%s: want a preview of at most %d characters ending in …, got %q (truncated=%v)",
				name, PreviewChars, m.BodyText, m.Truncated)
		}
		if !strings.HasPrefix(m.BodyText, "word word") {
			t.Fatalf("%s: preview should start with the text, got %q", name, m.BodyText)
		}
	}
	if m := byID[bigHTML]; !m.Truncated || m.BodyText != "Short text" || m.BodyHTML != "" {
		t.Fatalf("big formatting is left for the full view: %+v", m)
	}

	// Opening it shows everything.
	full := must(s.Message(ctx, b, plain, &conv))
	if full.Truncated || full.BodyText != long {
		t.Fatalf("the full view must show the whole message, got %d chars", len(full.BodyText))
	}
	// Search, threads and Spam/Trash lists preview too.
	if hits := must(s.Search(ctx, b, "word")).Messages; len(hits) == 0 || !hits[0].Truncated {
		t.Fatal("search results should be previews")
	}
	trash := "trash"
	must(0, s.UpdatePointer(ctx, b, plain, &conv, PointerPatch{Folder: &trash}))
	if f := must(s.Folder(ctx, b, "trash", Cursor{})); len(f) != 1 || !f[0].Truncated {
		t.Fatal("Trash should list previews")
	}
}

func TestCutPreview(t *testing.T) {
	cases := map[string]string{
		"short":                   "short",
		strings.Repeat("a", 150):  strings.Repeat("a", 100) + "…", // no space: cut hard
		strings.Repeat("ab ", 40): strings.TrimSpace(strings.Repeat("ab ", 33)) + "…",
		strings.Repeat("அ", 120):  strings.Repeat("அ", 100) + "…", // characters, not bytes
	}
	for in, want := range cases {
		if got := cutPreview(in, 100); got != want {
			t.Fatalf("cutPreview(%.20q…) = %q, want %q", in, got, want)
		}
	}
}

// Every delivery queues one alert per recipient (never the sender), in the same transaction.
func TestAlertQueue(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	r := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr), Cc: []Recipient{{Address: cAddr}}}, Subject: "Hi", BodyText: "x"}))
	must(s.Reply(ctx, b, r.MessageID, ReplyRequest{ConversationID: r.Conversations[0], BodyText: "back"}))
	var got []string
	rows, _ := s.DB.Query(ctx, `SELECT user_id || ':' || subject FROM alert_queue ORDER BY id`)
	for rows.Next() {
		var v string
		rows.Scan(&v)
		got = append(got, v)
	}
	want := []string{fmt.Sprintf("%d:Hi", b), fmt.Sprintf("%d:Hi", c), fmt.Sprintf("%d:Re: Hi", a)}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("queued alerts %v, want %v", got, want)
	}
}

// Deleting an account: others keep what it sent, shown as "Deleted account"; its groups hand
// over admin; nothing of the account remains.
func TestDeleteAccount(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	direct := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: "Keep me", BodyText: "hello"}))
	g := must(s.CreateGroup(ctx, a, "Team", []Recipient{{Address: bAddr}, {Address: cAddr}}))
	must(s.Send(ctx, b, SendRequest{Recipients: Recipients{To: toGroup(g.ConversationID)}, BodyText: "to all"}))
	must(s.AddDraftAttachment(ctx, a, must(s.SaveDraft(ctx, a, nil, DraftInput{BodyText: "d"})).ID, "f.txt", "text/plain", strings.NewReader("draft file")))
	must(s.CreateGroup(ctx, b, "Team", []Recipient{{Address: cAddr}})) // same name, B and C only

	phone := must(s.DeleteAccount(ctx, a))
	if phone != "+919876540001" {
		t.Fatalf("returned phone %q", phone)
	}
	var n int
	s.DB.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, a).Scan(&n)
	if n != 0 {
		t.Fatal("the user row must be gone")
	}
	// B still has A's mail, from "Deleted account", and can't reply into the dead chat.
	m := must(s.Message(ctx, b, direct.MessageID, nil))
	if m.Sender.DisplayName != DeletedName || m.Sender.Address != "" || m.BodyText != "hello" {
		t.Fatalf("kept mail should show a deleted sender: %+v", m.Sender)
	}
	if row := homeRow(t, s, ctx, b, direct.Conversations[0]); row.Peer != nil || row.Name != DeletedName {
		t.Fatalf("the chat should be labelled as a deleted account: %+v", row)
	}
	_, err := s.Reply(ctx, b, direct.MessageID, ReplyRequest{ConversationID: direct.Conversations[0], BodyText: "?"})
	wantCode(t, err, "account_deleted")
	// The group: A left, B (next longest member) is admin, and it didn't clash with B's own
	// "Team" of the same two people.
	grp := must(s.GetGroup(ctx, b, g.ConversationID))
	if len(grp.Members) != 2 {
		t.Fatalf("group should have 2 members left, got %d", len(grp.Members))
	}
	for _, mem := range grp.Members {
		if mem.UserID == b && mem.Role != "admin" {
			t.Fatal("admin should pass to the longest-standing member")
		}
	}
	evs := must(s.ChatEvents(ctx, c, g.ConversationID, nil, nil))
	if evs[len(evs)-2].Text != "Deleted account left" && evs[len(evs)-1].Text != "Deleted account left" {
		t.Fatalf("group should say the deleted account left: %+v", evs)
	}
	s.DB.QueryRow(ctx, `SELECT count(*) FROM drafts WHERE user_id = $1`, a).Scan(&n)
	if n != 0 {
		t.Fatal("drafts must be gone")
	}
}

// The export is one valid JSON document with the account, groups and every message in full.
func TestExport(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	_, bAddr := user(t, s, ctx, 2)
	long := strings.Repeat("long text ", 50)
	for i := 0; i < exportBatch+5; i++ { // more than one batch
		must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: fmt.Sprintf("msg %d", i)}))
	}
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: long}))
	var buf strings.Builder
	if err := s.Export(ctx, a, &buf); err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Account  struct{ Phone string }
		Messages []MessageView
	}
	if err := json.Unmarshal([]byte(buf.String()), &doc); err != nil {
		t.Fatalf("export is not valid JSON: %v", err)
	}
	if doc.Account.Phone != "+919876540001" || len(doc.Messages) != exportBatch+6 {
		t.Fatalf("account %q, %d messages", doc.Account.Phone, len(doc.Messages))
	}
	if last := doc.Messages[len(doc.Messages)-1]; last.BodyText != long || last.Truncated {
		t.Fatal("the export has full message text")
	}
}

// Suggestions while typing a recipient: your contacts and groups by partial text; anyone else
// on PhoneMail only by an exact number, address or alias.
func TestSuggest(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	stranger, strangerAddr := user(t, s, ctx, 4)
	s.DB.Exec(ctx, `UPDATE users SET display_name = 'Ravi Kumar' WHERE id = $1`, b)
	s.DB.Exec(ctx, `UPDATE users SET display_name = 'Meena Iyer' WHERE id = $1`, c)
	s.DB.Exec(ctx, `UPDATE users SET display_name = 'Rahul Stranger' WHERE id = $1`, stranger)
	s.DB.Exec(ctx, `INSERT INTO aliases (alias, user_id) VALUES ('meena.i@phonemail.com', $1)`, c)
	direct := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "hi"}))
	must(s.CreateGroup(ctx, a, "Buildathon", []Recipient{{Address: bAddr}, {Address: cAddr}}))
	must(s.CreateGroup(ctx, a, "Buildathon", []Recipient{{Address: bAddr}}))

	ids := func(r Suggestions) []int64 {
		var out []int64
		for _, p := range r.People {
			out = append(out, p.UserID)
		}
		return out
	}
	// By the start of a word in the name, with the direct chat when there is one.
	r := must(s.Suggest(ctx, a, "ra"))
	if len(r.People) != 1 || r.People[0].UserID != b || !r.People[0].Known || r.People[0].ConversationID == nil || *r.People[0].ConversationID != direct.Conversations[0] {
		t.Fatalf("'ra' should find Ravi only (a contact), not the stranger Rahul: %+v", r.People)
	}
	if got := ids(must(s.Suggest(ctx, a, "iyer"))); len(got) != 1 || got[0] != c {
		t.Fatalf("a later word of the name (a contact through a group): %v", got)
	}
	if got := ids(must(s.Suggest(ctx, a, "meena.i"))); len(got) != 1 || got[0] != c {
		t.Fatalf("by alias: %v", got)
	}
	if got := ids(must(s.Suggest(ctx, a, "98765 4000"))); len(got) != 2 {
		t.Fatalf("by the start of the number, contacts only (not the stranger): %v", got)
	}
	// Groups by name, with members to tell them apart.
	r = must(s.Suggest(ctx, a, "build"))
	if len(r.Groups) != 2 || len(r.Groups[0].Members)+len(r.Groups[1].Members) != 5 {
		t.Fatalf("both Buildathon groups with their members: %+v", r.Groups)
	}
	// A stranger: never by partial text, only by the exact number or address.
	if got := ids(must(s.Suggest(ctx, a, "rahul"))); len(got) != 0 {
		t.Fatalf("a stranger must not be found by name: %v", got)
	}
	r = must(s.Suggest(ctx, a, strangerAddr))
	if len(r.People) != 1 || r.People[0].UserID != stranger || r.People[0].Known {
		t.Fatalf("a stranger by exact address, marked not known: %+v", r.People)
	}
	if got := ids(must(s.Suggest(ctx, a, "+91 98765 40004"))); len(got) != 1 || got[0] != stranger {
		t.Fatalf("a stranger by exact number: %v", got)
	}
	if got := ids(must(s.Suggest(ctx, a, "someone@gmail.com"))); len(got) != 0 {
		t.Fatalf("outside addresses: nothing to suggest: %v", got)
	}
}
