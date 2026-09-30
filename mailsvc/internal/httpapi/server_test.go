package httpapi

// Needs TEST_DATABASE_URL (a database it may wipe), like the mail package's tests.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"phonemail/mailsvc/internal/db"
	"phonemail/mailsvc/internal/mail"
)

const token = "0123456789abcdef0123456789abcdef"

func setup(t *testing.T) (*mail.Service, *httptest.Server, []int64) {
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
	var ids []int64
	for i := 1; i <= 3; i++ {
		var id int64
		if err := pool.QueryRow(ctx, `INSERT INTO users (phone, display_name) VALUES ($1, $2) RETURNING id`,
			"+91987654000"+strconv.Itoa(i), "User "+strconv.Itoa(i)).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	svc := &mail.Service{DB: pool, Domain: "phonemail.com", AttachmentDir: t.TempDir(), MaxAttachment: 1 << 20}
	srv := httptest.NewServer((&Server{Svc: svc, Token: token}).Handler())
	t.Cleanup(srv.Close)
	return svc, srv, ids
}

func call(t *testing.T, srv *httptest.Server, user int64, method, path, ctype string, body io.Reader) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, body)
	req.Header.Set("X-Internal-Token", token)
	req.Header.Set("X-User-ID", strconv.FormatInt(user, 10))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

// Uploads are read part by part (streamed to disk), with other form fields before the file.
func TestStreamedUpload(t *testing.T) {
	svc, srv, ids := setup(t)
	d, err := svc.SaveDraft(context.Background(), ids[0], nil, mail.DraftInput{BodyText: "see file"})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("note", "ignored field before the file")
	fw, _ := mw.CreateFormFile("file", "report.txt")
	fw.Write([]byte(strings.Repeat("a", 300_000)))
	mw.Close()
	status, body := call(t, srv, ids[0], "POST", "/drafts/"+strconv.FormatInt(d.ID, 10)+"/attachments", mw.FormDataContentType(), &buf)
	if status != 201 {
		t.Fatalf("upload: %d %s", status, body)
	}
	var info mail.AttachmentInfo
	json.Unmarshal(body, &info)
	if info.SizeBytes != 300_000 || info.Filename != "report.txt" {
		t.Fatalf("unexpected %+v", info)
	}
	status, _ = call(t, srv, ids[0], "POST", "/drafts/"+strconv.FormatInt(d.ID, 10)+"/attachments", "text/plain", strings.NewReader("x"))
	if status != 400 {
		t.Fatalf("a non-multipart upload should be refused, got %d", status)
	}
}

// Opening a group chat returns the activity lines with the page of messages.
func TestChatPageHasEvents(t *testing.T) {
	svc, srv, ids := setup(t)
	g, err := svc.CreateGroup(context.Background(), ids[0], "Team", []mail.Recipient{{Address: "9876540002"}, {Address: "9876540003"}})
	if err != nil {
		t.Fatal(err)
	}
	status, body := call(t, srv, ids[1], "GET", "/conversations/"+strconv.FormatInt(g.ConversationID, 10)+"/messages", "", nil)
	if status != 200 {
		t.Fatalf("%d %s", status, body)
	}
	var page struct {
		Items  []mail.MessageView `json:"items"`
		Events []mail.ChatEvent   `json:"events"`
	}
	json.Unmarshal(body, &page)
	if len(page.Events) != 1 || page.Events[0].Text != "User 1 created the group" {
		t.Fatalf("want the creation line, got %+v", page.Events)
	}
}
