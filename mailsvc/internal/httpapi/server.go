// Package httpapi exposes the mail service over internal HTTP (spec 7).
// Only the API service calls it: every request carries X-Internal-Token and X-User-ID.
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"phonemail/mailsvc/internal/mail"
)

type Server struct {
	Svc    *mail.Service
	Token  string
	LogAll bool // log every request; otherwise only failures and slow ones (the API logs the rest)
}

type ctxKey struct{}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)

	h := func(pattern string, fn func(w http.ResponseWriter, r *http.Request, user int64)) {
		mux.Handle(pattern, s.auth(fn))
	}
	// Messages and threads
	h("POST /messages", s.send)
	h("GET /messages/{id}", s.getMessage)
	h("POST /messages/{id}/reply", s.reply)
	h("PATCH /mailbox/{messageId}", s.patchPointer)
	h("GET /threads/{rootId}", s.thread)
	// Home and chats
	h("GET /conversations", s.home)
	h("GET /conversations/{id}/messages", s.chatMessages)
	h("GET /conversations/{id}", s.getChat)
	h("POST /conversations/{id}/read", s.markRead)
	h("POST /conversations/actions", s.chatAction)
	h("PUT /messages/{id}/reaction", s.react)
	h("DELETE /messages/{id}/reaction", s.unreact)
	// People you blocked
	h("GET /blocks", s.listBlocks)
	h("POST /blocks", s.block)
	h("DELETE /blocks/{userId}", s.unblock)
	// Folders and search
	h("GET /folders/{folder}", s.folder)
	h("DELETE /trash", s.emptyTrash)
	h("GET /search", s.search)
	h("GET /suggest", s.suggest)
	// Drafts and attachments
	h("GET /drafts", s.listDrafts)
	h("POST /drafts", s.createDraft)
	h("GET /drafts/{id}", s.getDraft)
	h("PUT /drafts/{id}", s.updateDraft)
	h("DELETE /drafts/{id}", s.deleteDraft)
	h("POST /drafts/{id}/send", s.sendDraft)
	h("POST /drafts/{id}/unschedule", s.unscheduleDraft)
	h("POST /drafts/{id}/attachments", s.addAttachment)
	h("DELETE /drafts/{id}/attachments/{aid}", s.deleteAttachment)
	h("GET /attachments/{id}", s.getAttachment)
	// Groups
	h("GET /groups", s.listGroups)
	h("POST /groups", s.createGroup)
	h("GET /groups/{id}", s.getGroup)
	h("POST /groups/{id}/members", s.addMembers)
	h("DELETE /groups/{id}/members/{userId}", s.removeMember)
	h("PATCH /groups/{id}/members/{userId}", s.setRole)
	h("POST /groups/{id}/leave", s.leaveGroup)
	// The account as a whole
	h("DELETE /account", s.deleteAccount)
	h("GET /export", s.export)

	return logRequests(mux, s.LogAll)
}

func (s *Server) auth(fn func(http.ResponseWriter, *http.Request, int64)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Internal-Token")), []byte(s.Token)) != 1 {
			writeErr(w, &mail.Error{Status: 401, Code: "unauthorized", Message: "Missing or wrong X-Internal-Token."})
			return
		}
		user, err := strconv.ParseInt(r.Header.Get("X-User-ID"), 10, 64)
		if err != nil || user <= 0 {
			writeErr(w, &mail.Error{Status: 401, Code: "unauthorized", Message: "Missing or invalid X-User-ID."})
			return
		}
		if err := s.Svc.RequireUser(r.Context(), user); err != nil {
			writeErr(w, err)
			return
		}
		fn(w, r, user)
	})
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.Svc.DB.Ping(ctx); err != nil {
		writeJSON(w, 503, map[string]string{"status": "database unavailable"})
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var me *mail.Error
	if errors.As(err, &me) {
		writeJSON(w, me.Status, map[string]any{"error": map[string]string{"code": me.Code, "message": me.Message}})
		return
	}
	log.Printf("internal error [%s]: %v", w.Header().Get("X-Request-ID"), err)
	writeJSON(w, 500, map[string]any{"error": map[string]string{"code": "internal", "message": "Something went wrong."}})
}

// decode reads a JSON body strictly: unknown fields (like "gcc") are rejected.
func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 5<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return &mail.Error{Status: 400, Code: "bad_json", Message: "Invalid JSON: " + err.Error()}
	}
	return nil
}

func pathID(r *http.Request, name string) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || id <= 0 {
		return 0, &mail.Error{Status: 400, Code: "bad_request", Message: "Invalid " + name + "."}
	}
	return id, nil
}

func queryID(r *http.Request, name string) (*int64, error) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return nil, nil
	}
	id, err := strconv.ParseInt(v, 10, 64)
	if err != nil || id <= 0 {
		return nil, &mail.Error{Status: 400, Code: "bad_request", Message: "Invalid " + name + "."}
	}
	return &id, nil
}

// cursor reads ?before=<RFC3339 time>&before_id=<id>&limit=<n>.
func cursor(r *http.Request) (mail.Cursor, error) {
	var c mail.Cursor
	q := r.URL.Query()
	if v := q.Get("before"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return c, &mail.Error{Status: 400, Code: "bad_request", Message: "before must be an RFC 3339 time."}
		}
		c.Before = &t
		c.BeforeID = 1<<63 - 1
		if id := q.Get("before_id"); id != "" {
			if c.BeforeID, err = strconv.ParseInt(id, 10, 64); err != nil {
				return c, &mail.Error{Status: 400, Code: "bad_request", Message: "Invalid before_id."}
			}
		}
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return c, &mail.Error{Status: 400, Code: "bad_request", Message: "Invalid limit."}
		}
		c.Limit = n
	}
	return c, nil
}

var requestIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

// logRequests logs server errors and slow requests (or everything, with all set).
// The API already logs every request once, so logging them all here too would only
// double the log volume on the server's storage.
func logRequests(next http.Handler, all bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// The API gives every request an ID and passes it on; echoing it (and logging it)
		// lets one request be followed through both services' logs.
		id := r.Header.Get("X-Request-ID")
		if !requestIDRe.MatchString(id) {
			id = "-"
		}
		w.Header().Set("X-Request-ID", id)
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		took := time.Since(start)
		if r.URL.Path != "/health" && (all || sw.status >= 500 || took > time.Second) {
			log.Printf("[%s] %s %s %d %s", id, r.Method, r.URL.Path, sw.status, took.Round(time.Millisecond))
		}
	})
}
