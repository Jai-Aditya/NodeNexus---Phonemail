# PhoneMail mail service (Go)

Stores and serves all PhoneMail mail, following the team spec
("PhoneMail — Mail Service Spec"). The API service calls it over internal HTTP;
browsers never talk to it directly. Mail to and from other providers goes through Postfix (see "Mail from and to other providers" below).

## Run it

**Everything in Docker** (from the `phonemail` folder):

```powershell
docker compose up -d --build
Get-Content mailsvc/scripts/seed.sql | docker compose exec -T db psql -U phonemail -d phonemail   # 4 test users
curl.exe http://localhost:8081/health
```

**In GoLand** (database in Docker, service on your machine):

```powershell
docker compose up -d db
cd mailsvc
go mod download                  # first time only: fetches the pinned packages (go.sum)
$env:INTERNAL_TOKEN = "<the INTERNAL_TOKEN from ..\.env>"   # 32+ characters
$env:DATABASE_URL = "postgres://phonemail:<POSTGRES_PASSWORD from ..\.env>@localhost:5432/phonemail"
go run .
```

The schema is created automatically on start (`internal/db/migrations`).
Then open `requests.http` in GoLand and click ▶ next to each request.

## Tests

The tests use a real PostgreSQL and **wipe** the database you point them at, so use a separate one:

```powershell
docker compose exec db createdb -U phonemail phonemail_test
$env:TEST_DATABASE_URL = "postgres://phonemail:<POSTGRES_PASSWORD>@localhost:5432/phonemail_test"
go test -p 1 ./...
```

They cover the spec's test list: participant hash, direct-chat reuse, group identity,
recipient rules, Cc/Bcc visibility, reply-once, thread paths, new-member visibility,
last-admin promotion, counters, drafts, attachments, search, aliases, racing sends and cleanup.

## Layout

| Path | What's there |
| --- | --- |
| `main.go` | Starts everything: config, database, migrations, cleanup job, HTTP server |
| `internal/config` | Settings from environment variables |
| `internal/db` | Connection + migration runner; `migrations/0001_init.sql` is the schema |
| `internal/mail/deliver.go` | **Send and reply** (spec 6.1, 6.2): chats, pointers, reply-once, thread paths |
| `internal/mail/groups.go` | Create group (Gcc), add/remove/leave, admins, last-admin promotion |
| `internal/mail/read.go` | Home, chats, threads, traditional view, Spam/Trash lists, search |
| `internal/mail/flags.go` | Read/favourite/folder flags, empty Trash, background cleanup |
| `internal/mail/drafts.go`, `attachments.go` | Drafts and file uploads |
| `internal/httpapi` | HTTP routes and JSON handling |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://phonemail:phonemail@localhost:5432/phonemail` | PostgreSQL (compose builds it from `POSTGRES_PASSWORD`) |
| `DB_MAX_CONNS` | `10` | Database connections kept open at most |
| `INTERNAL_TOKEN` | *(required)* | Shared secret with the API service; 32+ characters, never a default |
| `MAIL_DOMAIN` | `phonemail.com` | Addresses are `<last 10 digits of phone>@<domain>` |
| `LISTEN_ADDR` | `:8081` | |
| `ATTACHMENT_DIR` | `./data/attachments` | Files are stored by SHA-256 (identical files stored once) |
| `MAX_ATTACHMENT_MB` | `25` | |
| `TRASH_RETENTION_DAYS` | `30` | Trash is emptied after this |
| `CLEANUP_INTERVAL_MINUTES` | `60` | Also deletes messages nobody points to any more |
| `SMTP_LISTEN` | (off; `:2525` in compose) | Where the host's Postfix hands over incoming mail for our domain |
| `SMTP_RELAY` | (empty) | Postfix for outgoing mail, e.g. `172.28.0.1:25`. Empty: outside addresses are refused (`external_disabled`) |
| `SMTP_HOSTNAME` | `mail.` + `MAIL_DOMAIN` | Our name in SMTP greetings |
| `MIGRATE_ON_START` | `true` | |
| `LOG_REQUESTS` | `false` | Log every request. Off: only failures and requests slower than 1 s (the API logs all requests once) |
| `MAX_RECIPIENTS` | `50` | To + Cc + Bcc per message |
| `MAX_GROUP_MEMBERS` | `256` | |
| `MAX_DRAFTS` | `200` | Drafts per person |
| `MAX_DRAFT_FILES` | `20` | Attachments per message |
| `MAX_USER_STORAGE_MB` | `1024` | Attachment space per person (their drafts and sent mail) |

Also fixed: a subject is one line of at most 255 characters; bodies at most 256 KB of text and
1 MB of HTML. `body_html` is cleaned when stored (bluemonday's allow-list: formatting, lists, tables,
links and images stay; scripts, styles, frames, forms, event attributes and `javascript:` links go),
so no client can receive HTML that runs code.

## Calling it (from the API service)

Every request needs `X-Internal-Token: <token>` and `X-User-ID: <logged-in user id>`.
Errors look like `{"error": {"code": "already_replied", "message": "You've already replied to this message."}}`.

A recipient is `{"address": "9876543210@phonemail.com"}` (also a bare phone number, `+91 …`, or an alias
like `kavya`), `{"group_id": 12}` or `{"group": "Goa crew"}` (one of your groups, by name). There's no `gcc` field: groups are created with `POST /groups`,
or by putting two or more people in To (below).

| Endpoint | Body / query |
| --- | --- |
| `POST /messages` | `{"to": R, "cc": [R], "bcc": [R], "subject", "body_text", "body_html", "forwarded_from_id"?}`; inside a chat: `{"conversation_id": 5, "subject", "body_text"}` (To is locked). `"to"` may also be a list of 2+ people with a `"group_name"`: see *Two or more people in To* |
| `POST /messages/{id}/reply` | `{"conversation_id", "body_text"}` |
| `GET /messages/{id}?conversation_id=` | Traditional view (marks read) |
| `PATCH /mailbox/{messageId}` | `{"conversation_id"?, "is_read"?, "is_favourite"?, "folder"?: inbox/spam/trash}` |
| `GET /conversations?filter=all\|unread\|attachments\|favorites\|snoozed\|archived\|everything` | Home (`everything` = "All mail": archived and snoozed chats too). Rows carry `archived`, `muted`, `snoozed_until` |
| `GET /conversations/{id}` | One chat's Home row (for its header) |
| `POST /conversations/actions` | `{"conversation_ids": [..], "action", "until"?}`, up to 100 at once. Actions: `archive`, `unarchive`, `trash` (all its emails), `read`, `unread` (newest email), `mute`, `unmute`, `snooze` (with `until`, at most a year), `unsnooze` |
| `PUT /messages/{id}/reaction` `{"emoji"}`, `DELETE /messages/{id}/reaction` | One reaction per person per email, from 👍 ❤️ 😂 😮 😢 🙏. Not for people who were Bcc'd |
| `GET /blocks`, `POST /blocks` `{"address"}`, `DELETE /blocks/{userId}` | People you blocked |
| `GET /conversations/{id}/messages` | Open a chat (first page marks it read); returns `items`, `events` (group activity lines) and `next` |
| `POST /conversations/{id}/read` | Mark a chat read |
| `GET /threads/{rootId}?conversation_id=` | Whole thread, in order |
| `GET /folders/spam`, `GET /folders/trash`, `DELETE /trash` | Spam / Trash |
| `GET /search?q=` | Messages (word prefixes), a person by number/alias, groups by name. Operators: `from:` `to:` (`me`, a number/address, or a name), `has:attachment`, `after:` `before:` (`2026-09-30`, India time), `in:inbox\|sent\|archived\|spam\|trash\|anywhere` (default: inbox), `is:unread\|read\|starred`; quote values with spaces |
| `GET /suggest?q=` | Recipients while typing: contacts (people you share any conversation with) by name word, number start or alias start; your groups by name, with members; anyone else only by exact number, address or alias (`known: false`) |
| `GET/POST /drafts`, `GET/PUT/DELETE /drafts/{id}`, `POST /drafts/{id}/send` | Drafts (`{"recipients": {"to": R, ...}, "conversation_id"?, "parent_id"?, "forwarded_from_id"?, ...}`). Send takes an optional `{"send_at": time}` (scheduled send) or `{"delay_seconds": n}` (undo send, up to 60): checked at once, then `202` with the draft, which carries `send_at` |
| `POST /drafts/{id}/unschedule` | Take a waiting draft back (Undo, or cancel a scheduled send); `409 already_sent` if too late |
| `POST /drafts/{id}/attachments` (multipart field `file`), `DELETE /drafts/{id}/attachments/{aid}`, `GET /attachments/{id}` | Files |
| `GET /groups`, `POST /groups` `{"name", "members": [R]}`, `GET /groups/{id}` | Groups |
| `POST /groups/{id}/members` `{"members": [R]}`, `DELETE /groups/{id}/members/{userId}`, `PATCH /groups/{id}/members/{userId}` `{"role"}`, `POST /groups/{id}/leave` | Group admin |
| `DELETE /account` | Erase the calling user (the API confirms their password or code first); returns `{"phone"}` |
| `GET /export` | Everything held about the calling user, as one streamed JSON file |

Lists are newest first, 30 per page. To load older items, pass the `next` object back:
`?before=<next.before>&before_id=<next.before_id>`.

## Notifications for the API service

After each delivery the service runs `pg_notify('mail_events', …)` inside the same transaction,
so the event arrives only once the mail is committed. The API service should `LISTEN mail_events`:

```json
{"type":"message","message_id":6,"conversation_id":5,"sender_id":4,
 "sender_address":"9876500004@phonemail.com","subject":"Ping","user_ids":[1]}
```

`user_ids` are the people to alert (never the sender): push to their open browsers, and SMS
"You have received an email from <Sender>. Subject: <Subject>." to those with `has_push = false`.
`muted` lists who of them muted the chat (no alert is queued for them). Other types: `group_created`,
`group_members_added`, `group_member_left`, `group_event`, `chats` (the user changed chats on another device,
or a snooze ended), `reaction` (someone reacted to an email the user has) and `draft_failed` (a scheduled
email couldn't be sent; it's a draft again with `send_error`).

## Design notes worth knowing for the demo

- **Mail from and to other providers** (`inbound.go`, `outside.go`), with the standard Postfix interface, so an
  existing Postfix works unchanged. Incoming: Postfix hands mail for our domain to the SMTP listener;
  RCPT is checked against the database (unknown addresses get 550 before any data is accepted). Outgoing: a
  message with outside recipients goes into the `outbox` table in the same transaction; a worker hands it to
  Postfix (DKIM-signed there), retrying after 1, 2, 4… minutes. Someone outside PhoneMail is an *external* user
  (address, no phone, no sign-in) in an ordinary one-to-one chat; they can't be in groups (`outside_group`).
  An answer from outside joins the thread it answers (In-Reply-To / References); a second answer to the same
  email threads under their first. Forged senders (our own addresses) are refused, Postfix's `X-Spam-Flag: YES`
  and blocked senders go to Spam, and the same Message-ID is stored once.

- **Gmail-style extras (30 Sep).** *Archive* hides a chat from Home until new mail arrives (per person;
  "All mail" still lists it). *Snooze* hides it until a time, then brings it back to the top with the newest email
  unread; new mail ends a snooze early. *Mute* keeps mail arriving but queues no push or SMS. *Block* sends a
  person's direct mail to your Spam, without an alert (groups are not affected: the group decides who's in it).
  *Send later* is a draft with `send_at`; the scheduler (every 2 s, in `schedule.go`) sends due drafts through the
  normal send path. Undo send is the same with a few seconds' delay. A scheduled send is checked in full when it's
  scheduled (a rolled-back dry run), so errors like `group_name_required` come back at once, not later; if it
  still fails when due (a group was left), the draft comes back with `send_error`. A draft waiting to be sent
  can't be edited (`409 scheduled`) until it's taken back.

- **Stored once, pointers per person.** `messages` holds each email once; `mailbox` rows are each person's
  pointers with their own flags. `user_conversations` is the Home screen, kept up to date on every delivery.
- **Chat identity.** Direct chats are unique per pair of people; groups are unique per (members, name).
  Both use a SHA-256 of the sorted member ids.
- **Threads** use PostgreSQL `ltree` paths of zero-padded ids, so a whole thread comes back in order in one query.
- **Two or more people in To start a group** (the brief's Home rule), and it **must be named**: without
  `group_name` the service answers `400 group_name_required`, so the client asks for a name and sends again.
  The list becomes one new group (sender as admin) and the group is the message's single To, so every message
  still has exactly one To. The same person listed twice is an ordinary one-to-one email, and mail to one
  person always stays in the direct chat.
- **Existing groups are addressed by name**, in To, Cc or Bcc: `{"group": "Goa crew"}` (any letter case), or just
  typed as an address when it matches no person. Only the sender's own current groups are searched. Listing the
  same people with the same name again is refused (`409 group_exists`, "send to it by its name"). The same
  name with different people is a separate group; if you're in more than one group with that name, the bare
  name is ambiguous (`409 ambiguous_group`): the client asks which one (showing each group's members) and sends by `group_id`.
- **Group activity lines** ("Asha created the group", "Asha added Ravi", "Meena left", "Asha removed Ravi",
  "Asha made Ravi an admin", "Ravi is now an admin" after automatic promotion) are stored in
  `conversation_events`, not in `messages`, so they can't be replied to, searched or counted as unread. Opening a
  chat returns them as `events` next to `items`, covering the same stretch of time as that page. Each has a
  ready `text` worded for the viewer ("You added Ravi", "Asha added you") plus `kind`, `actor` and `target` for
  clients that word it themselves. People see only lines from while they were members. A `group_event` is
  published so open chats can show new lines live.
- **Lists show previews; long emails are opened to be read.** Chats, threads, Spam/Trash and search return at
  most 100 characters of each email's text (cut at a word, ending in "…") with `"truncated": true`, and no
  HTML for those. Short emails come whole, with their formatting (HTML up to 4 KB). `GET /messages/{id}`
  always returns the full email. The database only sends the first 101 characters of a long body for
  lists, so long emails aren't transferred at all just to be listed.
- **Alerts are queued with the delivery.** Each recipient (never the sender) gets an `alert_queue` row in the
  same transaction as the mail, so an alert exists exactly when the mail does; the API sends them.
- **Deleted accounts.** `DELETE /account` makes the person leave their groups (admin handed over, "Deleted
  account left"), then deletes the user row: their number, profile, aliases, sessions, drafts and own copies of
  mail go; mail they sent stays with its recipients with `sender_id` NULL, shown as "Deleted account". A direct
  chat with them stays readable (named "Deleted account"), but replying gives `410 account_deleted`.
- **Reply once per person** is a unique index on `(parent_id, sender_id)`: the database enforces it, even under races.
- **New group members** only receive threads started after they joined: replies go only to members whose
  `joined_at` is before the thread root's `sent_at`.
- **No deadlocks:** deliveries lock rows in a fixed order (by chat id, then user id).
- The `users` table belongs to the API service; this service only reads it (plus `aliases`).
  `phone_local` (last 10 digits) is derived from `phone` by the database.
