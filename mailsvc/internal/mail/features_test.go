package mail

import (
	"context"
	"strings"
	"testing"
	"time"
)

func homeIDs(t *testing.T, s *Service, ctx context.Context, user int64, filter string) map[int64]bool {
	t.Helper()
	out := map[int64]bool{}
	for _, c := range must(s.Home(ctx, user, filter, Cursor{})) {
		out[c.ConversationID] = true
	}
	return out
}

// Archive hides a chat from Home until new mail arrives; All mail still lists it.
// Trash moves every email of the chat; mark unread brings back one unread email.
func TestChatActions(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	r := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: "Hi", BodyText: "one"}))
	conv := r.Conversations[0]

	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "archive"}))
	if homeIDs(t, s, ctx, b, "all")[conv] || !homeIDs(t, s, ctx, b, "archived")[conv] || !homeIDs(t, s, ctx, b, "everything")[conv] {
		t.Fatal("archived chat should leave Home but be in Archived and All mail")
	}
	if !homeIDs(t, s, ctx, a, "all")[conv] {
		t.Fatal("archiving is per person: A's Home must keep the chat")
	}
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: "Again", BodyText: "two"}))
	if !homeIDs(t, s, ctx, b, "all")[conv] {
		t.Fatal("new mail should bring an archived chat back")
	}

	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "read"}))
	if homeRow(t, s, ctx, b, conv).UnreadCount != 0 {
		t.Fatal("read should clear unread")
	}
	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "unread"}))
	if homeRow(t, s, ctx, b, conv).UnreadCount != 1 {
		t.Fatal("unread should mark the newest email unread")
	}

	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "trash"}))
	if homeIDs(t, s, ctx, b, "all")[conv] {
		t.Fatal("a trashed chat should leave Home")
	}
	if n := len(must(s.Folder(ctx, b, "trash", Cursor{}))); n != 2 {
		t.Fatalf("both emails should be in Trash, got %d", n)
	}
	// Not a member: not found. Unknown action: bad request.
	c, _ := user(t, s, ctx, 3)
	_, err := s.ChatAction(ctx, c, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "archive"})
	wantCode(t, err, "not_found")
	_, err = s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "explode"})
	wantCode(t, err, "bad_request")
	_ = aAddr
}

// Snooze hides a chat until its time, then it comes back unread; new mail ends it early.
// Mute keeps mail coming but queues no alerts.
func TestSnoozeAndMute(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	conv := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "hello"})).Conversations[0]
	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "read"}))

	_, err := s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "snooze"})
	wantCode(t, err, "bad_request") // needs a time
	until := time.Now().Add(time.Hour)
	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "snooze", Until: &until}))
	if homeIDs(t, s, ctx, b, "all")[conv] || !homeIDs(t, s, ctx, b, "snoozed")[conv] {
		t.Fatal("snoozed chat should be under Snoozed, not Home")
	}
	// Time's up (pretend): it comes back unread.
	s.DB.Exec(ctx, `UPDATE user_conversations SET snoozed_until = now() - interval '1 second' WHERE user_id = $1`, b)
	if n := must(s.wakeSnoozed(ctx)); n != 1 {
		t.Fatalf("want 1 chat woken, got %d", n)
	}
	row := homeRow(t, s, ctx, b, conv)
	if row.UnreadCount != 1 || row.SnoozedUntil != nil {
		t.Fatalf("woken chat should be unread and not snoozed: %+v", row)
	}

	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "mute"}))
	if !must(s.Chat(ctx, b, conv)).Muted {
		t.Fatal("chat should show as muted")
	}
	var before, after int
	s.DB.QueryRow(ctx, `SELECT count(*) FROM alert_queue WHERE user_id = $1`, b).Scan(&before)
	must(s.Send(ctx, a, SendRequest{ConversationID: &conv, BodyText: "quiet please"}))
	s.DB.QueryRow(ctx, `SELECT count(*) FROM alert_queue WHERE user_id = $1`, b).Scan(&after)
	if after != before {
		t.Fatal("a muted chat must not queue alerts")
	}
	if homeRow(t, s, ctx, b, conv).UnreadCount != 2 {
		t.Fatal("muted chats still receive mail")
	}
}

// Blocking: the blocked person's direct mail goes to Spam, quietly; groups are unaffected.
func TestBlock(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	_, cAddr := user(t, s, ctx, 3)
	conv := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "before"})).Conversations[0]
	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "read"}))

	blocked := must(s.Block(ctx, b, aAddr))
	if blocked.UserID != a {
		t.Fatal("blocked the wrong person")
	}
	_, err := s.Block(ctx, b, bAddr)
	wantCode(t, err, "bad_request")

	var alerts int
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "after"}))
	s.DB.QueryRow(ctx, `SELECT count(*) FROM alert_queue WHERE user_id = $1`, b).Scan(&alerts)
	if alerts != 1 { // only the first email alerted
		t.Fatalf("mail from a blocked person must not alert, got %d alerts", alerts)
	}
	if homeRow(t, s, ctx, b, conv).UnreadCount != 0 {
		t.Fatal("blocked mail must not count as unread in Home")
	}
	spam := must(s.Folder(ctx, b, "spam", Cursor{}))
	if len(spam) != 1 || spam[0].BodyText != "after" {
		t.Fatalf("blocked mail should be in Spam: %+v", spam)
	}
	// A group with both of them still works as usual.
	g := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, cAddr), GroupName: "Trip"}, BodyText: "group"}))
	if homeRow(t, s, ctx, b, g.Conversations[0]).UnreadCount != 1 {
		t.Fatal("group mail isn't affected by blocking")
	}

	if n := len(must(s.Blocks(ctx, b))); n != 1 {
		t.Fatalf("want 1 blocked, got %d", n)
	}
	must(0, s.Unblock(ctx, b, a))
	wantCode(t, s.Unblock(ctx, b, a), "not_found")
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, BodyText: "unblocked"}))
	if homeRow(t, s, ctx, b, conv).UnreadCount != 1 {
		t.Fatal("after unblocking, mail arrives in the inbox again")
	}
}

// Reactions: one per person, replaced by a new one, removed with ""; Bcc'd people can't.
func TestReactions(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, cAddr := user(t, s, ctx, 3)
	r := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr), Bcc: []Recipient{{Address: cAddr}}}, BodyText: "hi"}))
	msg := r.MessageID

	must(0, s.React(ctx, b, msg, "👍"))
	must(0, s.React(ctx, a, msg, "👍"))
	must(0, s.React(ctx, b, msg, "❤️")) // replaces B's 👍
	wantCode(t, s.React(ctx, b, msg, "🍕"), "bad_request")
	wantCode(t, s.React(ctx, c, msg, "👍"), "forbidden")

	m := must(s.Message(ctx, a, msg, nil))
	if len(m.Reactions) != 2 || m.Reactions[0].Emoji != "👍" || m.Reactions[0].Count != 1 || !m.Reactions[0].Mine ||
		m.Reactions[1].Emoji != "❤️" || m.Reactions[1].Names[0] != "User 2" {
		t.Fatalf("unexpected reactions: %+v", m.Reactions)
	}
	must(0, s.React(ctx, b, msg, ""))
	if m := must(s.Message(ctx, a, msg, nil)); len(m.Reactions) != 1 {
		t.Fatalf("removing should leave 1 reaction, got %+v", m.Reactions)
	}
	_ = c
}

// Send later: a scheduled draft is checked up front, can be taken back (Undo) and edited,
// and is sent by the scheduler when due. A failing one goes back to being a draft.
func TestScheduledSend(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)

	// Checked at once: an unknown address fails now, not later.
	bad := must(s.SaveDraft(ctx, a, nil, DraftInput{Recipients: Recipients{To: to("1111111111")}, BodyText: "x"}))
	_, err := s.ScheduleDraft(ctx, a, bad.ID, time.Now().Add(time.Minute))
	wantCode(t, err, "not_found")

	d := must(s.SaveDraft(ctx, a, nil, DraftInput{Recipients: Recipients{To: to(bAddr)}, Subject: "Later", BodyText: "scheduled"}))
	sd := must(s.ScheduleDraft(ctx, a, d.ID, time.Now().Add(time.Hour)))
	if sd.SendAt == nil {
		t.Fatal("draft should be scheduled")
	}
	_, err = s.SaveDraft(ctx, a, &d.ID, DraftInput{Recipients: Recipients{To: to(bAddr)}, BodyText: "edit"})
	wantCode(t, err, "scheduled")
	_, err = s.SendDraft(ctx, a, d.ID)
	wantCode(t, err, "scheduled")
	var n int
	s.DB.QueryRow(ctx, `SELECT count(*) FROM messages`).Scan(&n)
	if n != 0 {
		t.Fatal("checking a scheduled send must not send anything")
	}
	if sent := must(s.sendDue(ctx)); sent != 0 {
		t.Fatal("nothing is due yet")
	}

	// Undo: back to a draft, editable again.
	back := must(s.UnscheduleDraft(ctx, a, d.ID))
	if back.SendAt != nil {
		t.Fatal("unscheduled draft should have no send time")
	}
	must(s.SaveDraft(ctx, a, &d.ID, DraftInput{Recipients: Recipients{To: to(bAddr)}, Subject: "Later", BodyText: "edited"}))

	// Due now: the scheduler sends it and the draft is used up.
	must(s.ScheduleDraft(ctx, a, d.ID, time.Now()))
	if sent := must(s.sendDue(ctx)); sent != 1 {
		t.Fatalf("want 1 sent, got %d", sent)
	}
	_, err = s.UnscheduleDraft(ctx, a, d.ID)
	wantCode(t, err, "already_sent")
	chats := must(s.Home(ctx, b, "all", Cursor{}))
	if len(chats) != 1 || chats[0].Snippet != "edited" {
		t.Fatalf("B should have the edited email: %+v", chats)
	}

	// A due draft that can no longer be sent comes back with the reason: here A left the group.
	_, cAddr := user(t, s, ctx, 3)
	gid := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr, cAddr), GroupName: "G"}, BodyText: "g"})).Conversations[0]
	gd := must(s.SaveDraft(ctx, a, nil, DraftInput{ConversationID: &gid, BodyText: "too late"}))
	must(s.ScheduleDraft(ctx, a, gd.ID, time.Now()))
	must(0, s.LeaveGroup(ctx, a, gid))
	if sent := must(s.sendDue(ctx)); sent != 0 {
		t.Fatal("a draft to a group you left can't be sent")
	}
	failed := must(s.GetDraft(ctx, a, gd.ID))
	if failed.SendAt != nil || failed.SendError == "" {
		t.Fatalf("failed draft should be back with a reason: %+v", failed)
	}
}

// Search operators narrow message searches.
func TestSearchOperators(t *testing.T) {
	s, ctx := setup(t)
	a, aAddr := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: "Budget", BodyText: "numbers"}))
	must(s.Send(ctx, b, SendRequest{Recipients: Recipients{To: to(aAddr)}, Subject: "Budget reply", BodyText: "more numbers"}))
	d := must(s.SaveDraft(ctx, a, nil, DraftInput{Recipients: Recipients{To: to(bAddr)}, Subject: "With file", BodyText: "see file"}))
	must(s.AddDraftAttachment(ctx, a, d.ID, "a.txt", "text/plain", strings.NewReader("hello")))
	must(s.SendDraft(ctx, a, d.ID))

	count := func(q string) int { return len(must(s.Search(ctx, b, q)).Messages) }
	if n := count("budget"); n != 2 {
		t.Fatalf("budget: want 2, got %d", n)
	}
	if n := count("budget from:me"); n != 1 {
		t.Fatalf("from:me: want 1, got %d", n)
	}
	if n := count("from:" + aAddr); n != 2 {
		t.Fatalf("from:A: want 2, got %d", n)
	}
	if n := count("from:\"User 1\""); n != 2 {
		t.Fatalf("from:name: want 2, got %d", n)
	}
	if n := count("has:attachment"); n != 1 {
		t.Fatalf("has:attachment: want 1, got %d", n)
	}
	if n := count("is:unread"); n != 2 {
		t.Fatalf("is:unread: want 2, got %d", n)
	}
	if n := count("after:2000-01-01 before:2100-01-01 budget"); n != 2 {
		t.Fatalf("date range: want 2, got %d", n)
	}
	if n := count("before:2000-01-01"); n != 0 {
		t.Fatalf("before 2000: want 0, got %d", n)
	}
	_, err := s.Search(ctx, b, "before:yesterday")
	wantCode(t, err, "bad_request")
	// Trash is only searched with in:trash.
	hits := must(s.Search(ctx, b, "budget from:me")).Messages
	must(0, s.UpdatePointer(ctx, b, hits[0].ID, nil, PointerPatch{Folder: ptr("trash")}))
	if count("budget from:me") != 0 || count("budget from:me in:trash") != 1 || count("budget in:anywhere") != 2 {
		t.Fatal("in: should choose the folder")
	}
}

func ptr[T any](v T) *T { return &v }
