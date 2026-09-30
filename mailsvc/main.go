// Command mailsvc is the PhoneMail mail service: it stores and serves all mail
// for the API service over internal HTTP. See README.md.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"phonemail/mailsvc/internal/config"
	"phonemail/mailsvc/internal/db"
	"phonemail/mailsvc/internal/httpapi"
	"phonemail/mailsvc/internal/mail"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer pool.Close()

	if cfg.MigrateOnStart {
		if err := db.Migrate(ctx, pool); err != nil {
			log.Fatalf("migrate: %v", err)
		}
		log.Print("database schema is up to date")
	}

	svc := &mail.Service{
		DB:             pool,
		Domain:         cfg.MailDomain,
		AttachmentDir:  cfg.AttachmentDir,
		MaxAttachment:  cfg.MaxAttachment,
		TrashRetention: cfg.TrashRetention,
		Limits:         cfg.Limits,
		SMTPRelay:      cfg.SMTPRelay,
		SMTPHostname:   cfg.SMTPHostname,
		LegacyDomains:  cfg.LegacyDomains,
		OtherMailboxes: cfg.OtherMailboxes,
	}
	go svc.RunCleanup(ctx, cfg.CleanupInterval)
	// Scheduled and undo-able sends, and snoozed chats coming back. Every 2 s, so an
	// "Undo" window ends within a couple of seconds of its time.
	go svc.RunScheduler(ctx, 2*time.Second)
	// Outside mail: outgoing through Postfix, incoming from Postfix.
	go svc.RunOutbound(ctx, 5*time.Second)
	if cfg.SMTPListen != "" {
		go func() {
			if err := svc.ServeSMTP(ctx, cfg.SMTPListen); err != nil && ctx.Err() == nil {
				log.Fatalf("smtp: %v", err)
			}
		}()
	}

	srv := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: (&httpapi.Server{Svc: svc, Token: cfg.InternalToken, LogAll: cfg.LogRequests}).Handler(),
		// Only the API calls this service, over the Docker network, so every stage is quick.
		// The limits stop a stuck or misbehaving caller from holding connections forever.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute, // a 25 MB upload arriving through the API
		WriteTimeout:      5 * time.Minute, // a 25 MB download leaving through the API
		IdleTimeout:       2 * time.Minute, // unused keep-alive connections
	}
	go func() {
		<-ctx.Done()
		// Finish requests in progress, for up to 15 s (Docker waits 20 s before killing us).
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()

	outside := "off"
	if cfg.SMTPRelay != "" {
		outside = "via " + cfg.SMTPRelay
	}
	log.Printf("mail service listening on %s (domain %s, outside mail %s)", cfg.ListenAddr, cfg.MailDomain, outside)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("http: %v", err)
	}
}
