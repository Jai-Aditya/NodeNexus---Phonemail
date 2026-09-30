// Package config reads the mail service settings from environment variables.
package config

import (
	"fmt"
	"os"
	"phonemail/mailsvc/internal/mail"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL   string // DATABASE_URL
	ListenAddr    string // LISTEN_ADDR, default ":8081"
	MailDomain    string // MAIL_DOMAIN, e.g. "phonemail.com"
	InternalToken string // INTERNAL_TOKEN: shared secret with the API service
	AttachmentDir string // ATTACHMENT_DIR
	MaxAttachment int64  // MAX_ATTACHMENT_MB, in bytes
	// Mail to and from other providers, through Postfix.
	SMTPListen   string // SMTP_LISTEN, e.g. ":2525": Postfix hands incoming mail here. Empty = off
	SMTPRelay    string // SMTP_RELAY, e.g. "172.28.0.1:25": outgoing mail goes to Postfix. Empty = refused
	SMTPHostname string // SMTP_HOSTNAME, default "mail." + MAIL_DOMAIN
	// MAIL_LEGACY_DOMAINS: earlier domains, comma-separated, whose addresses still arrive (e.g. legacy.example)
	LegacyDomains   map[string]bool
	OtherMailboxes  map[string]bool // OTHER_MAILBOXES: full addresses of ordinary mailboxes on our domains
	TrashRetention  time.Duration   // TRASH_RETENTION_DAYS
	CleanupInterval time.Duration   // CLEANUP_INTERVAL_MINUTES
	MigrateOnStart  bool            // MIGRATE_ON_START, default true
	DBMaxConns      int             // DB_MAX_CONNS, default 10
	LogRequests     bool            // LOG_REQUESTS: log every request (default: only errors and slow ones)
	Limits          mail.Limits
}

// weakTokens appear in examples and must never protect a real deployment.
var weakTokens = map[string]bool{"change-me-dev-token": true, "change-me": true, "secret": true, "changeme": true}

func Load() (Config, error) {
	c := Config{
		DatabaseURL:    env("DATABASE_URL", "postgres://phonemail:phonemail@localhost:5432/phonemail"),
		ListenAddr:     env("LISTEN_ADDR", ":8081"),
		MailDomain:     strings.ToLower(env("MAIL_DOMAIN", "phonemail.com")),
		InternalToken:  os.Getenv("INTERNAL_TOKEN"),
		AttachmentDir:  env("ATTACHMENT_DIR", "./data/attachments"),
		SMTPListen:     os.Getenv("SMTP_LISTEN"),
		SMTPRelay:      os.Getenv("SMTP_RELAY"),
		MigrateOnStart: env("MIGRATE_ON_START", "true") == "true",
	}
	mb, err := strconv.Atoi(env("MAX_ATTACHMENT_MB", "25"))
	if err != nil || mb <= 0 {
		return c, fmt.Errorf("MAX_ATTACHMENT_MB must be a positive number")
	}
	c.MaxAttachment = int64(mb) << 20

	days, err := strconv.Atoi(env("TRASH_RETENTION_DAYS", "30"))
	if err != nil || days <= 0 {
		return c, fmt.Errorf("TRASH_RETENTION_DAYS must be a positive number")
	}
	c.TrashRetention = time.Duration(days) * 24 * time.Hour

	mins, err := strconv.Atoi(env("CLEANUP_INTERVAL_MINUTES", "60"))
	if err != nil || mins <= 0 {
		return c, fmt.Errorf("CLEANUP_INTERVAL_MINUTES must be a positive number")
	}
	c.CleanupInterval = time.Duration(mins) * time.Minute

	if c.InternalToken == "" {
		return c, fmt.Errorf("INTERNAL_TOKEN is required (a shared secret with the API service)")
	}
	if weakTokens[c.InternalToken] || len(c.InternalToken) < 32 {
		return c, fmt.Errorf("INTERNAL_TOKEN is a default or shorter than 32 characters: " +
			"set a random value, e.g. the output of: openssl rand -hex 32")
	}
	c.LogRequests = env("LOG_REQUESTS", "false") == "true"
	ints := []struct {
		name string
		def  int
		dst  *int
	}{
		{"DB_MAX_CONNS", 10, &c.DBMaxConns},
		{"MAX_RECIPIENTS", 50, &c.Limits.MaxRecipients},
		{"MAX_GROUP_MEMBERS", 256, &c.Limits.MaxGroupMembers},
		{"MAX_DRAFTS", 200, &c.Limits.MaxDrafts},
		{"MAX_DRAFT_FILES", 20, &c.Limits.MaxDraftFiles},
	}
	for _, v := range ints {
		n, err := strconv.Atoi(env(v.name, strconv.Itoa(v.def)))
		if err != nil || n <= 0 {
			return c, fmt.Errorf("%s must be a positive number", v.name)
		}
		*v.dst = n
	}
	storage, err := strconv.Atoi(env("MAX_USER_STORAGE_MB", "1024"))
	if err != nil || storage <= 0 {
		return c, fmt.Errorf("MAX_USER_STORAGE_MB must be a positive number")
	}
	c.Limits.MaxUserStorage = int64(storage) << 20
	c.SMTPHostname = env("SMTP_HOSTNAME", "mail."+c.MailDomain)
	c.OtherMailboxes = map[string]bool{}
	for _, a := range strings.Split(os.Getenv("OTHER_MAILBOXES"), ",") {
		if a = strings.ToLower(strings.TrimSpace(a)); strings.Contains(a, "@") {
			c.OtherMailboxes[a] = true
		}
	}
	c.LegacyDomains = map[string]bool{}
	for _, d := range strings.Split(os.Getenv("MAIL_LEGACY_DOMAINS"), ",") {
		if d = strings.ToLower(strings.TrimSpace(d)); d != "" && d != c.MailDomain {
			c.LegacyDomains[d] = true
		}
	}
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
