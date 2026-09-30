package httpapi

import (
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"time"

	"phonemail/mailsvc/internal/mail"
)

// page wraps a list with the cursor for the next (older) page.
type page[T any] struct {
	Items []T      `json:"items"`
	Next  *nextRef `json:"next,omitempty"`
}

type nextRef struct {
	Before   time.Time `json:"before"`
	BeforeID int64     `json:"before_id"`
}

func paged[T any](items []T, limit int, key func(T) (time.Time, int64)) page[T] {
	if items == nil {
		items = []T{}
	}
	p := page[T]{Items: items}
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	if len(items) == limit {
		t, id := key(items[len(items)-1])
		p.Next = &nextRef{Before: t, BeforeID: id}
	}
	return p
}

func msgKey(m mail.MessageView) (time.Time, int64) { return m.SentAt, m.ID }

// ---- messages ----

func (s *Server) send(w http.ResponseWriter, r *http.Request, user int64) {
	var req mail.SendRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	res, err := s.Svc.Send(r.Context(), user, req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, res)
}

func (s *Server) reply(w http.ResponseWriter, r *http.Request, user int64) {
	parent, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var req mail.ReplyRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	res, err := s.Svc.Reply(r.Context(), user, parent, req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, res)
}

func (s *Server) getMessage(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	conv, err := queryID(r, "conversation_id")
	if err != nil {
		writeErr(w, err)
		return
	}
	m, err := s.Svc.Message(r.Context(), user, id, conv)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, m)
}

func (s *Server) patchPointer(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "messageId")
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		ConversationID *int64 `json:"conversation_id,omitempty"`
		mail.PointerPatch
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.UpdatePointer(r.Context(), user, id, body.ConversationID, body.PointerPatch); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) thread(w http.ResponseWriter, r *http.Request, user int64) {
	root, err := pathID(r, "rootId")
	if err != nil {
		writeErr(w, err)
		return
	}
	conv, err := queryID(r, "conversation_id")
	if err != nil || conv == nil {
		writeErr(w, &mail.Error{Status: 400, Code: "bad_request", Message: "conversation_id is required."})
		return
	}
	msgs, err := s.Svc.Thread(r.Context(), user, *conv, root)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": msgs})
}

// ---- home and chats ----

func (s *Server) home(w http.ResponseWriter, r *http.Request, user int64) {
	cur, err := cursor(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	chats, err := s.Svc.Home(r.Context(), user, r.URL.Query().Get("filter"), cur)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, paged(chats, cur.Limit, func(c mail.ChatSummary) (time.Time, int64) {
		return c.LastMessageAt, c.ConversationID
	}))
}

func (s *Server) chatMessages(w http.ResponseWriter, r *http.Request, user int64) {
	conv, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	cur, err := cursor(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	msgs, err := s.Svc.ChatMessages(r.Context(), user, conv, cur)
	if err != nil {
		writeErr(w, err)
		return
	}
	// Group activity lines in the same stretch of time as this page of messages:
	// from the oldest message shown (or the start, on the last page) up to the cursor.
	p := paged(msgs, cur.Limit, msgKey)
	var after *time.Time
	if p.Next != nil {
		after = &p.Next.Before
	}
	events, err := s.Svc.ChatEvents(r.Context(), user, conv, after, cur.Before)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, struct {
		page[mail.MessageView]
		Events []mail.ChatEvent `json:"events"`
	}{p, events})
}

func (s *Server) getChat(w http.ResponseWriter, r *http.Request, user int64) {
	conv, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	c, err := s.Svc.Chat(r.Context(), user, conv)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, c)
}

// chatAction: {"conversation_ids": [..], "action": "archive" | ..., "until": time (snooze)}.
func (s *Server) chatAction(w http.ResponseWriter, r *http.Request, user int64) {
	var req mail.ChatActionRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	n, err := s.Svc.ChatAction(r.Context(), user, req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]int{"changed": n})
}

// react: {"emoji": "👍"}. One reaction per person per email; a new one replaces the old.
func (s *Server) react(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Emoji string `json:"emoji"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if body.Emoji == "" {
		writeErr(w, &mail.Error{Status: 400, Code: "bad_request", Message: "emoji is required."})
		return
	}
	if err := s.Svc.React(r.Context(), user, id, body.Emoji); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) unreact(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.React(r.Context(), user, id, ""); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) listBlocks(w http.ResponseWriter, r *http.Request, user int64) {
	list, err := s.Svc.Blocks(r.Context(), user)
	if err != nil {
		writeErr(w, err)
		return
	}
	if list == nil {
		list = []mail.BlockedPerson{}
	}
	writeJSON(w, 200, map[string]any{"items": list})
}

// block: {"address": "9876543210"} (a number, address or alias).
func (s *Server) block(w http.ResponseWriter, r *http.Request, user int64) {
	var body struct {
		Address string `json:"address"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	b, err := s.Svc.Block(r.Context(), user, body.Address)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, b)
}

func (s *Server) unblock(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "userId")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.Unblock(r.Context(), user, id); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) markRead(w http.ResponseWriter, r *http.Request, user int64) {
	conv, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.MarkChatRead(r.Context(), user, conv); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- folders and search ----

func (s *Server) folder(w http.ResponseWriter, r *http.Request, user int64) {
	cur, err := cursor(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	msgs, err := s.Svc.Folder(r.Context(), user, r.PathValue("folder"), cur)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, paged(msgs, cur.Limit, msgKey))
}

func (s *Server) emptyTrash(w http.ResponseWriter, r *http.Request, user int64) {
	n, err := s.Svc.EmptyTrash(r.Context(), user)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]int64{"deleted": n})
}

func (s *Server) search(w http.ResponseWriter, r *http.Request, user int64) {
	res, err := s.Svc.Search(r.Context(), user, r.URL.Query().Get("q"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, res)
}

// suggest offers recipients for what is being typed in To, Cc or Bcc.
func (s *Server) suggest(w http.ResponseWriter, r *http.Request, user int64) {
	res, err := s.Svc.Suggest(r.Context(), user, r.URL.Query().Get("q"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, res)
}

// ---- drafts and attachments ----

func (s *Server) listDrafts(w http.ResponseWriter, r *http.Request, user int64) {
	d, err := s.Svc.ListDrafts(r.Context(), user)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": d})
}

func (s *Server) createDraft(w http.ResponseWriter, r *http.Request, user int64) {
	var in mail.DraftInput
	if err := decode(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	d, err := s.Svc.SaveDraft(r.Context(), user, nil, in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, d)
}

func (s *Server) getDraft(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	d, err := s.Svc.GetDraft(r.Context(), user, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, d)
}

func (s *Server) updateDraft(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var in mail.DraftInput
	if err := decode(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	d, err := s.Svc.SaveDraft(r.Context(), user, &id, in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, d)
}

func (s *Server) deleteDraft(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.DeleteDraft(r.Context(), user, id); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// sendDraft sends a draft now, or with {"send_at": time} or {"delay_seconds": n} later
// (scheduled send; undo send is a delay of a few seconds). A later send is checked now and
// answers 202 with the draft, which /unschedule takes back until it goes.
func (s *Server) sendDraft(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var when struct {
		SendAt       *time.Time `json:"send_at,omitempty"`
		DelaySeconds int        `json:"delay_seconds,omitempty"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &when); err != nil {
			writeErr(w, err)
			return
		}
	}
	if when.DelaySeconds < 0 || when.DelaySeconds > 60 {
		writeErr(w, &mail.Error{Status: 400, Code: "bad_request", Message: "delay_seconds must be 0 to 60."})
		return
	}
	if when.SendAt != nil || when.DelaySeconds > 0 {
		at := time.Now().Add(time.Duration(when.DelaySeconds) * time.Second)
		if when.SendAt != nil {
			at = *when.SendAt
		}
		d, err := s.Svc.ScheduleDraft(r.Context(), user, id, at)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 202, d)
		return
	}
	res, err := s.Svc.SendDraft(r.Context(), user, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, res)
}

func (s *Server) unscheduleDraft(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	d, err := s.Svc.UnscheduleDraft(r.Context(), user, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, d)
}

// addAttachment takes a multipart upload with the file in the "file" field. The file is
// streamed straight to disk (hashed on the way), never held in memory as a whole.
func (s *Server) addAttachment(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.Svc.MaxAttachment+1<<20)
	noFile := &mail.Error{Status: 400, Code: "bad_request", Message: "Upload the file as multipart form field \"file\"."}
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, noFile)
		return
	}
	var part *multipart.Part
	for {
		if part, err = mr.NextPart(); err != nil {
			writeErr(w, noFile)
			return
		}
		if part.FormName() == "file" && part.FileName() != "" {
			break
		}
		part.Close()
	}
	defer part.Close()
	info, err := s.Svc.AddDraftAttachment(r.Context(), user, id, part.FileName(), part.Header.Get("Content-Type"), part)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, info)
}

func (s *Server) deleteAttachment(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	aid, err := pathID(r, "aid")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.DeleteDraftAttachment(r.Context(), user, id, aid); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) getAttachment(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	info, f, err := s.Svc.OpenAttachment(r.Context(), user, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", info.ContentType)
	w.Header().Set("Content-Length", fmt.Sprint(info.SizeBytes))
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": info.Filename}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, f)
}

// ---- groups ----

func (s *Server) listGroups(w http.ResponseWriter, r *http.Request, user int64) {
	g, err := s.Svc.ListGroups(r.Context(), user)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": g})
}

// createGroup is compose with Gcc: {"name": "...", "members": [{"address": "..."}]}.
func (s *Server) createGroup(w http.ResponseWriter, r *http.Request, user int64) {
	var body struct {
		Name    string           `json:"name"`
		Members []mail.Recipient `json:"members"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	g, err := s.Svc.CreateGroup(r.Context(), user, body.Name, body.Members)
	if err != nil {
		writeErr(w, err)
		return
	}
	status := 200
	if g.Created {
		status = 201
	}
	writeJSON(w, status, g)
}

func (s *Server) getGroup(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	g, err := s.Svc.GetGroup(r.Context(), user, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, g)
}

func (s *Server) addMembers(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Members []mail.Recipient `json:"members"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	g, err := s.Svc.AddMembers(r.Context(), user, id, body.Members)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, g)
}

func (s *Server) removeMember(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	target, err := pathID(r, "userId")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.RemoveMember(r.Context(), user, id, target); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) setRole(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	target, err := pathID(r, "userId")
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Role string `json:"role"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.SetRole(r.Context(), user, id, target, body.Role); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) leaveGroup(w http.ResponseWriter, r *http.Request, user int64) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Svc.LeaveGroup(r.Context(), user, id); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- the account as a whole ----

// deleteAccount erases the calling user (the API checks their password or code first).
func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request, user int64) {
	phone, err := s.Svc.DeleteAccount(r.Context(), user)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": true, "phone": phone})
}

// export streams everything held about the user as a JSON file download.
func (s *Server) export(w http.ResponseWriter, r *http.Request, user int64) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="phonemail-export.json"`)
	if err := s.Svc.Export(r.Context(), user, w); err != nil {
		// Headers (and maybe part of the file) are already sent: log it; the file is incomplete.
		log.Printf("export for user %d failed: %v", user, err)
	}
}
