# PhoneMail web client

React 19 + Vite + TypeScript, written for this api
(HttpOnly cookie session, live updates over Server-Sent Events). Served by nginx in the `web`
container, which also passes `/api/` and `/twilio/` to the api: open **http://localhost:8080**
after `docker compose up -d --build`.

| Screen | Route | Notes |
|---|---|---|
| Language (first visit) | `/welcome` | English; Hindi and Tamil shown but not selectable yet (`ENABLED` in `src/lib/i18n.ts`) |
| Sign in / sign up | `/login` | Phone + SMS code + Next, Terms line above the button; password as the fallback |
| Sign-up portal | `/register/` | Two fields; creates the account without signing in, then clears |
| Forgot password | `/forgot` | Code by SMS, new password; other devices signed out |
| Inbox and filters | `/`, `/?f=unread` … `/?f=snoozed`, `/?f=everything` (All mail) | One row per chat, unread badge, live updates. Tick boxes (phones: "Select") for bulk archive, delete, mark read/unread, snooze |
| Conversation | `/c/:id` | Shown as its threads, ordered by latest email. Wide screens: Gmail-style, a thread's emails one below the other (long middles fold into "N more emails"). Phones: Reddit-style, each reply nested under the email it answers with a thread line; collapse any branch; past 4 levels "Continue this thread". Opens at the newest email (the bottom); the writing box is docked under it. What you write and don't send waits in the conversation as its draft (WhatsApp-style, kept on the server; the chat list shows "Draft: …"; not in the Drafts folder); ✕ discards it. Group activity lines, group info sheet |
| Spam, Trash, Drafts, Scheduled, Search | `/spam` `/trash` `/drafts` `/scheduled` `/search?q=` | Search options (the sliders in the search box) write Gmail operators: `from:`, `to:`, `has:attachment`, `after:`, `before:`, `in:`, `is:` |
| Settings | `/settings` | Picture (number bloom or styled photo), name, password, aliases, notifications, signature, undo-send time, keyboard shortcuts on/off, blocked people, download data, delete account |

- **Looks:** indigo with marigold accents on warm paper (`src/index.css`, colours at the top); dark theme follows the
  device. Inter is bundled (no font CDN). Layout: Gmail-style from 720 px wide, WhatsApp-style below.
- **Compose:** To, Cc and Bcc suggest recipients as you type (`GET /api/mail/suggest`): people you already share a
  conversation with, by name, number or alias; your groups, with their members so same-named groups can be told apart;
  anyone else on PhoneMail only when their exact number, address or alias is typed (so nobody can browse the user list).
  A group name matching several of your groups asks which one. Two or more people start a new group and need a group
  name. Everything autosaves to Drafts (a chosen group is kept by id); attachments upload onto the draft.
- **Long emails:** lists carry 100-character previews (`truncated`); "Read more" fetches the whole email.
- **Gmail-style extras:** formatting (bold, italic, underline, lists, links; `src/mail/Editor.tsx`) and a signature;
  Send waits out an *Undo* window (Settings, default 10 s; held on the server, so closing the tab is safe) and the
  arrow next to Send schedules it; Forward (with the original's files); mark unread; archive; snooze; mute; block;
  emoji reactions; pictures and PDFs open in a viewer; keyboard shortcuts (`?` lists them: c, /, j/k, o, x, e, #,
  Shift+I/U, r, f, u, Ctrl+Enter).
- **Mail domain:** read from the server (`/api/auth/config`) at start, so it always matches the api.

## Develop

```powershell
npm install
npm run dev        # http://localhost:5173, /api proxied to the api on :3000 (API_TARGET to change)
npm run build      # type-check and build to dist/
npm run lint
```

## Browser tests

`e2e/` drives real Chromium against the running stack (needs `AUTH_MODE=console`, since sign-in codes are read from
the api's log): three people sign up and use every screen on desktop and phone sizes (24 tests). Test people have
Undo send turned off so Send is immediate; one test turns it on. Screenshots of each screen
land in `e2e/screenshots/`.

```powershell
cd e2e
npm install
npx playwright install chromium   # first time
npm test
```

Against a server, reading sign-in codes from its log over SSH:

```bash
BASE_URL=https://<server> MAIL_DOMAIN=<domain> \
CODES_CMD='ssh <user>@<server> "cd <folder> && docker compose logs api --since 15m"' npx playwright test
```
