# Running PhoneMail: tests, backups, production

## Services and ports

Every port is bound to this computer only (`127.0.0.1`); change them in `.env` if one is taken.

| Service | Folder | Port (setting) | Job |
|---|---|---|---|
| PostgreSQL 16 | (image) | 5432 (`DB_PORT`) | all data |
| Mail service (Go) | `mailsvc/` | 8081 (`MAILSVC_PORT`), SMTP 2525 (`SMTP_PORT`) | storing, threading and delivering mail |
| API (Node.js) | `api/` | 3000 (`API_PORT`) | sign-in, accounts, SMS and call sign-up, alerts, live updates; forwards mail calls to the Go service |
| Web client (React) | `web/` | 8080 (`WEB_PORT`) | the web app and sign-up portal, served by nginx, which also passes `/api/` to the API |
| Postfix (SMTP) | `postfix/` | 25 (`POSTFIX_PORT`) | mail to and from other providers ("SMTP local"). On with `COMPOSE_PROFILES=postfix`; a server with its own Postfix leaves it off |

## Tests

The whole system, through the running containers (90 checks; needs `AUTH_MODE=console` in `.env`,
so sign-in codes appear in the api's log):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
```

Automated tests. They **wipe** the database they're given, so use a separate one:

```powershell
docker compose exec db createdb -U phonemail phonemail_test
$env:TEST_DATABASE_URL = "postgres://phonemail:<POSTGRES_PASSWORD>@localhost:5432/phonemail_test"
cd mailsvc; go test -p 1 ./...; cd ..\api; npm install; npm test
cd ..\web\e2e; npm install; npx playwright install chromium; npm test   # browser tests
```

(On macOS/Linux: `export TEST_DATABASE_URL=...` and the same commands.)

## Back up and restore

```bash
bash scripts/backup.sh                          # database + attachments + pictures -> backups/<date>/
bash scripts/restore.sh backups/20261001-031500 # replaces ALL current data (asks first)
```

`BACKUP_DIR` chooses where backups go and `KEEP_DAYS` (default 14) how long they're kept.
Run it nightly from cron (see the top of `scripts/backup.sh`) and keep backups on a different disk
from the data. Backups are readable by their owner only.

## Production (behind nginx, https)

In `.env`: `COOKIE_SECURE=true`, `TRUST_PROXY=true`, the real `PUBLIC_BASE_URL` (Twilio signs its
webhooks against it), and the country codes you text in `SMS_COUNTRY_CODES`. The host's nginx
(https) forwards the public name to the web container on `127.0.0.1:8080` with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
`proxy_set_header X-Forwarded-Proto https;` and `proxy_buffering off;` (live updates).

For email on the public internet the domain also needs an MX record pointing at the server, SPF,
DKIM (signing, e.g. with OpenDKIM next to Postfix) and DMARC, and ideally reverse DNS
for the server's IP.

On a server that already runs its own Postfix: leave `COMPOSE_PROFILES` and the Postfix container out,
point that Postfix at the mail service (mail for your domain to `127.0.0.1:2525`, verifying recipients
there first) and set `SMTP_RELAY` to it.

## Settings reference

Every setting is described in [`.env.example`](../.env.example) and in the service READMEs
([mailsvc](../mailsvc/README.md#settings), [api](../api/README.md#settings)).
