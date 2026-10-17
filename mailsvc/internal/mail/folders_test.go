package mail

import (
	"strconv"
	"strings"
	"testing"
)

// Folders are per person: filing a chat archives it into the folder, new mail brings it back
// to Home while it stays filed, unfile returns it to Home, and deleting a folder keeps the mail.
func TestCustomFolders(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	b, bAddr := user(t, s, ctx, 2)
	c, _ := user(t, s, ctx, 3)
	conv := must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: "Hi", BodyText: "one"})).Conversations[0]

	// Names: trimmed, unique per person whatever the capitals, built-in names refused.
	fam := must(s.CreateFolder(ctx, b, "  Family   matters "))
	if fam.Name != "Family matters" {
		t.Fatalf("name should be tidied, got %q", fam.Name)
	}
	_, err := s.CreateFolder(ctx, b, "family MATTERS")
	wantCode(t, err, "folder_exists")
	_, err = s.CreateFolder(ctx, b, "Spam")
	wantCode(t, err, "bad_request")
	_, err = s.CreateFolder(ctx, b, "   ")
	wantCode(t, err, "bad_request")
	_, err = s.CreateFolder(ctx, b, strings.Repeat("x", MaxFolderName+1))
	wantCode(t, err, "bad_request")
	must(s.CreateFolder(ctx, c, "Family matters")) // another person may use the same name

	// Move: out of Home and Archived, into the folder; All mail still lists it.
	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "move", FolderID: &fam.ID}))
	in := homeIDs(t, s, ctx, b, inFolder(fam.ID))
	if !in[conv] || homeIDs(t, s, ctx, b, "all")[conv] || homeIDs(t, s, ctx, b, "archived")[conv] || !homeIDs(t, s, ctx, b, "everything")[conv] {
		t.Fatal("a filed chat should be in its folder and All mail only")
	}
	if must(s.Chat(ctx, b, conv)).FolderID == nil {
		t.Fatal("the chat row should say which folder it is in")
	}
	if homeIDs(t, s, ctx, a, "all")[conv] != true {
		t.Fatal("folders are per person: A's Home must keep the chat")
	}
	list := must(s.Folders(ctx, b))
	if len(list) != 1 || list[0].ChatCount != 1 || list[0].UnreadCount != 1 {
		t.Fatalf("folder list should count 1 chat with 1 unread, got %+v", list)
	}

	// Someone else's folder, or one that doesn't exist: not found.
	other := must(s.Folders(ctx, c))[0].ID
	_, err = s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "move", FolderID: &other})
	wantCode(t, err, "not_found")
	_, err = s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "move"})
	wantCode(t, err, "bad_request")
	_, err = s.Home(ctx, b, "folder:abc", Cursor{})
	wantCode(t, err, "bad_request")
	if len(must(s.Home(ctx, b, inFolder(other), Cursor{}))) != 0 {
		t.Fatal("another person's folder must list nothing")
	}

	// New mail: back in Home, still in the folder.
	must(s.Send(ctx, a, SendRequest{Recipients: Recipients{To: to(bAddr)}, Subject: "Again", BodyText: "two"}))
	if !homeIDs(t, s, ctx, b, "all")[conv] || !homeIDs(t, s, ctx, b, inFolder(fam.ID))[conv] {
		t.Fatal("new mail should bring the chat to Home and keep it in its folder")
	}

	// Rename keeps the chats; a clash is refused.
	must(s.CreateFolder(ctx, b, "Work"))
	wantCode(t, s.RenameFolder(ctx, b, fam.ID, "work"), "folder_exists")
	if err := s.RenameFolder(ctx, b, fam.ID, "Family"); err != nil {
		t.Fatal(err)
	}
	wantCode(t, s.RenameFolder(ctx, c, fam.ID, "Mine now"), "not_found")
	if !homeIDs(t, s, ctx, b, inFolder(fam.ID))[conv] {
		t.Fatal("renaming must keep the folder's chats")
	}

	// Unfile: out of the folder, back in Home.
	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "move", FolderID: &fam.ID}))
	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "unfile"}))
	if homeIDs(t, s, ctx, b, inFolder(fam.ID))[conv] || !homeIDs(t, s, ctx, b, "all")[conv] {
		t.Fatal("unfile should take the chat out of its folder and back to Home")
	}

	// Delete: the chat stays (archived), its emails stay.
	must(s.ChatAction(ctx, b, ChatActionRequest{ConversationIDs: []int64{conv}, Action: "move", FolderID: &fam.ID}))
	if err := s.DeleteFolder(ctx, b, fam.ID); err != nil {
		t.Fatal(err)
	}
	wantCode(t, s.DeleteFolder(ctx, b, fam.ID), "not_found")
	if !homeIDs(t, s, ctx, b, "archived")[conv] || len(must(s.ChatMessages(ctx, b, conv, Cursor{}))) != 2 {
		t.Fatal("deleting a folder should leave its chat archived with all its emails")
	}
	if must(s.Chat(ctx, b, conv)).FolderID != nil {
		t.Fatal("the chat should no longer point at the deleted folder")
	}
}

func TestFolderLimit(t *testing.T) {
	s, ctx := setup(t)
	a, _ := user(t, s, ctx, 1)
	for i := 0; i < MaxFolders; i++ {
		must(s.CreateFolder(ctx, a, "Folder "+strconv.Itoa(i)))
	}
	_, err := s.CreateFolder(ctx, a, "One too many")
	wantCode(t, err, "bad_request")
}

// inFolder is the Home filter for one folder.
func inFolder(id int64) string { return "folder:" + strconv.FormatInt(id, 10) }
