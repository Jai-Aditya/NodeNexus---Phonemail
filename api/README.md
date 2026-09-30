# PhoneMail API (Node.js)

The front door for the web and mobile clients. It:

- **logs people in** with their phone number and a one-time code (Twilio Verify), or a password when no OTP provider is available;
- **owns accounts** in PostgreSQL: sessions, profile (name, language, picture), aliases, push subscriptions;
- **forwards all mail calls** to the Go mail service, adding the shared secret and the logged-in user's id;
- **creates accounts by phone**: call the Twilio number and press 1, or text JOIN;
- **pushes live updates** to open browser tabs, and **alerts** each recipient of a new mail: a push notification if they installed the app (enabled push), otherwise the SMS the brief asks for: `You have received an email from <Sender>. Subject: <Subject>.`

Browsers only ever talk to this service (port 3000). The mail service (8081) is internal.

```
browser ──cookie──▶ API :3000 ──X-Internal-Token + X-User-ID──▶ mail service :8081
                      │  ▲                                          │
                      │  └──── LISTEN mail_events ◀── pg_notify ────┘
                      └──▶ PostgreSQL (users, sessions, …)        (same database)
```

## Run it

Everything, from the repository root:

```powershell
copy .env.example .env      # then edit .env (optional for a first try)
docker compose up -d --build
docker compose logs -f api
```

With no Twilio settings, `AUTH_MODE=auto` falls back to **password** login. To try one-time codes without Twilio, set `AUTH_MODE=console` in `.env`; codes appear in `docker compose logs api`.

Just the API on your machine (database and mail service in Docker):

```powershell
cd api
npm install
copy .env.example .env
npm run dev                 # restarts on file changes
```

## Tests

The tests need a PostgreSQL database they may **wipe** (not your real one):

```powershell
docker compose exec db psql -U phonemail -c "CREATE DATABASE phonemail_test"
$env:TEST_DATABASE_URL="postgres://phonemail:<POSTGRES_PASSWORD>@localhost:5432/phonemail_test"
npm test
```

26 tests: OTP and password login, rate limits, CSRF/CORS, profile, aliases, picture upload, the mail gateway, the IVR and SMS webhooks (including signature checks), live events through LISTEN, SMS alerts, and a web push that the test decrypts like a browser would.

## Endpoints

All request and response bodies are JSON. Errors look like `{"error": {"code": "wrong_code", "message": "…"}}`.
**Every POST/PUT/PATCH/DELETE must send the header `X-Requested-With: fetch`** (any value works; see Security).

| Method & path | What it does |
|---|---|
| `GET /api/auth/config` | `{mode: "otp" \| "password", domain, default_country_code}`: tells the login screen what to show |
| `POST /api/auth/otp/start` | `{phone}`: texts a code. Numbers like `98765 43210` get +91 added |
| `POST /api/auth/otp/verify` | `{phone, code, client}`: logs in, creating the account if new. `client`: `web` (cookie), `mobile` (returns `token`, see *Apps*) or `portal` (creates the account but doesn't log in) |
| `POST /api/auth/register` | `{phone, password, client}`: password mode only |
| `POST /api/auth/login` | `{phone, password}`: password mode |
| `POST /api/auth/logout` | `{everywhere: true}` logs out every device |
| `GET /api/me`, `PATCH /api/me` | profile; patch `{display_name, language, signature, undo_send_seconds}` (signature up to 1000 characters; undo 0, 5, 10, 20 or 30 seconds, default 10) |
| `DELETE /api/me` | delete the account: `{password}`, or `{code}` (from `POST /api/auth/otp/start`) for accounts without a password. Mail already sent stays with its recipients, from "Deleted account" |
| `GET /api/me/export` | download everything held about you as one JSON file (3 per hour) |
| `PUT /api/me/avatar` | raw image body with `Content-Type: image/png` (jpeg, webp, gif), max 2 MB |
| `DELETE /api/me/avatar` | remove picture |
| `PUT /api/me/password` | `{current_password, new_password}`; logs out your other devices |
| `GET/POST /api/me/aliases`, `DELETE /api/me/aliases/:alias` | up to 5 aliases like `kavya.rao@phonemail.com` |
| `GET /api/push/public-key` | VAPID key for the service worker |
| `POST/DELETE /api/push/subscriptions` | save/remove the browser's `PushSubscription` |
| `GET /api/events` | Server-Sent Events stream: `ready`, `message`, `group_created`, `chats`, `reaction`, `draft_failed`, … |
| `ANY /api/mail/…` | forwarded to the mail service: `/api/mail/conversations` → `/conversations` (see `mailsvc/README.md`) |
| `GET /api/health` | database + mail service status |
| `POST /twilio/voice`, `/twilio/voice/menu`, `/twilio/sms` | Twilio webhooks (IVR and SMS sign-up) |

From the browser:

```js
const api = (path, opts = {}) => fetch(path, {
  ...opts,
  credentials: 'include',                       // send the session cookie
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...opts.headers },
}).then(async (r) => { const b = await r.json(); if (!r.ok) throw b.error; return b; });

await api('/api/auth/otp/start', { method: 'POST', body: JSON.stringify({ phone: '9876543210' }) });

const events = new EventSource('/api/events', { withCredentials: true });
events.addEventListener('message', (e) => console.log('new mail', JSON.parse(e.data)));
```

(`EventSource` has a built-in `onmessage` for unnamed events; our events are named, so use `addEventListener('message', …)`.)

## Setting up Twilio

1. Sign up at twilio.com (trial is fine). A trial account can only text **numbers you verify** in the console, so verify your team's phones.
2. Console → Verify → Services → create one. Put its SID (`VA…`) in `TWILIO_VERIFY_SID`, and the account SID/auth token in `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`.
3. Buy (with trial credit) a phone number; put it in `TWILIO_FROM_NUMBER`.
4. For the IVR and SMS sign-up, Twilio must reach your API from the internet. Run `ngrok http 3000`, put the `https://…` address in `PUBLIC_BASE_URL`, and in the number's settings set
   - *A call comes in* → Webhook, `https://…/twilio/voice`, HTTP POST
   - *A message comes in* → Webhook, `https://…/twilio/sms`, HTTP POST
5. `docker compose up -d` again to pick up the new `.env`.

A real toll-free Indian number isn't possible on a trial; any Twilio number demonstrates the flow.

## Settings

| Variable | Default | |
|---|---|---|
| `INTERNAL_TOKEN` | (required) | same secret as the mail service; 32+ characters in production, never a default |
| `DATABASE_URL` | `postgres://phonemail:phonemail@localhost:5432/phonemail` | |
| `MAIL_SERVICE_URL` | `http://localhost:8081` | |
| `AUTH_MODE` | `auto` | `auto`, `twilio`, `console`, `password` |
| `MAIL_DOMAIN` | `phonemail.com` | |
| `DEFAULT_COUNTRY_CODE` | `91` | added to 10-digit numbers |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID`, `TWILIO_FROM_NUMBER` | | |
| `TWILIO_VALIDATE_SIGNATURE` | `true` | only turn off for local experiments |
| `PUBLIC_BASE_URL` | | public address Twilio calls (signature check uses it) |
| `CORS_ORIGINS` | | comma-separated frontend origins, e.g. `http://localhost:5173` |
| `COOKIE_SECURE` | `false` | set `true` when served over https |
| `TRUST_PROXY` | `false` | `true` behind nginx: the client IP is the **last** `X-Forwarded-For` entry (the one nginx added; earlier entries are whatever the client sent) |
| `SMS_COUNTRY_CODES` | `DEFAULT_COUNTRY_CODE` | country codes we text (codes, alerts, replies); others get `400 country_not_supported` |
| `SEND_PER_MINUTE`, `SEND_PER_DAY` | `30`, `500` | emails (new, replies, drafts sent) per person; then `429` |
| `SMS_ALERT_MINUTES` | `15` | at most one SMS alert per person per chat in this time; the subject in it is cut to 40 characters |
| `MAX_STREAMS_PER_USER` | `5` | open live-update streams per person; the oldest closes |
| `SESSION_DAYS` | `30` | |
| `SMS_ALERTS` | `true` | turn off to save trial credit |
| `AVATAR_DIR` | `./data/avatars` | |
| `PORT` | `3000` | |

## Layout

```
src/
  server.js           start-up: config, database, migrations, LISTEN, HTTP server, shutdown
  app.js              security checks (CORS, CSRF, headers) and route table
  config.js           environment variables
  db.js               PostgreSQL connection + this service's migrations
  migrations/         sessions, otp_codes, push_subscriptions, app_settings
  accounts.js         create/find users, profile, aliases, passwords
  http/router.js      tiny router (":param" and "/*")
  http/util.js        JSON, errors, cookies, body reading
  auth/phone.js       phone number normalisation (E.164)
  auth/otp.js         one-time codes: Twilio Verify or console
  auth/password.js    scrypt password hashing
  auth/sessions.js    session cookies
  auth/ratelimit.js   in-memory rate limiter
  twilio/client.js    Twilio REST calls + webhook signatures
  twilio/webhooks.js  IVR and SMS sign-up
  push/webpush.js     Web Push encryption (RFC 8291) and VAPID (RFC 8292)
  push/store.js       push subscriptions
  realtime/events.js  Server-Sent Events, mail_events listener, push-or-SMS alerts
  routes/             auth, me, push, mail (gateway)
test/                 node:test suite
```

## Why it's built this way

- **No Express.** Node's built-in `http` module plus a 60-line router. The only dependency is `postgres` (the PostgreSQL driver). Fewer packages means less to learn, audit and break. Swapping to Express later is easy: the handlers are plain `(req, res)` functions.
- **Cookie sessions, not JWTs.** A random token in an `HttpOnly` cookie; the database stores only its SHA-256. JavaScript on the page can't read it, logging out really ends it, and "log out everywhere" is one `DELETE`.
- **CSRF.** Cookies are sent automatically, so another website could try to make your browser POST here. Browsers won't let another site add a custom header like `X-Requested-With` without our CORS permission, so requiring it blocks that. `SameSite=Lax` is a second layer.
- **Server-Sent Events, not WebSockets.** Updates only flow server → browser; SSE is plain HTTP, reconnects by itself and works through nginx.
- **Push vs SMS.** The brief sends SMS "only for users without the mobile app". Our mobile client is a web app, so "has the app" means "enabled push notifications" (`users.has_push`). If a push fails because the subscription expired, the user falls back to SMS.
- **The mail service never sees cookies.** The gateway builds fresh headers: the shared secret and the user id. A client can't fake `X-User-ID`.
- **Credentials never spoken on calls.** Caller ID can be spoofed, so the IVR only reads out the address; anything secret (a temporary password) goes by SMS, which reaches the real owner.

## Security notes (added)

- **Live streams end with the session.** Logging out closes that session's `/api/events` streams at once;
  "log out everywhere" and a password change close the user's other streams. Every 5 minutes the API also
  drops streams whose session has expired or been deleted by other means.
- **Every response** carries `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`
  (the API returns data, never pages), and `Strict-Transport-Security` when `COOKIE_SECURE=true`.
- **Search** is limited to 30 per minute per person, and recipient suggestions (`/api/mail/suggest`) to 120: both
  can look up registered numbers, and suggestions only match strangers by their exact number.
- **Timeouts:** a client must finish *sending* a request within 5 minutes (`requestTimeout`); long
  *responses* such as the live-update stream are not affected. Shutdown lets requests in progress finish
  for up to 10 seconds.

## Apps: Bearer tokens

Native apps log in with `client: "mobile"`; the response carries `token` (and `expires_in`, in seconds)
instead of setting a cookie. Send it on every call as `Authorization: Bearer <token>`. It's the same
session as a browser's cookie (logout, "log out everywhere" and a password change end it), and calls
with it don't need `X-Requested-With` (a browser never adds an Authorization header by itself, so
another website can't forge one). Browsers never receive the raw token.

## Alerts (push or SMS)

The mail service queues one alert per recipient in `alert_queue`, in the same transaction as the
delivery, so none is lost to a restart. The API's sender (`src/realtime/alerts.js`) works through it:
a push notification if the person enabled push, otherwise the brief's SMS. Texts leave at
`SMS_PER_SECOND` (default 1, what a US long-code number accepts), at most one per person per chat per
`SMS_ALERT_MINUTES`, with the subject cut to 40 characters. Failures Twilio may recover from (429, 5xx,
network) are retried after 30 s, 1, 2 and 4 minutes; others (e.g. an invalid number) are marked
`failed` with the reason. Finished rows are kept a week, then removed.

## Other protections

- **Profile pictures** lose their hidden metadata (EXIF/XMP/IPTC: GPS position, camera, time) before
  they're stored; a JPEG keeps only its rotation, so portrait photos still show upright.
- **Push notifications** only go to the browsers' real push services (Google, Mozilla, Apple, Microsoft),
  at most 10 browsers or apps per person.
- **Wrong passwords** are limited per address + number (10 per 15 min), per address (50) and per number
  (100 an hour): someone guessing locks themselves out, not the owner.
- **Request IDs:** every response has `X-Request-ID` (kept from nginx if it sent one); it's in the API's
  and the mail service's log lines and in `500` errors, so a reported failure can be traced in both.
