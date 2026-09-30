# Buildathon requirements: where each one stands


| No. | Requirements | Status | Where / how it's checked |
|---|---|---|---|
| 1 | The phone number is the email address (`9876543210@<domain>`) | Done | `mailsvc` addresses; every test suite |
| 2 | Sign up by calling a number and pressing 1 | Done (needs a Twilio number) | `api/src/twilio/webhooks.js`; api tests + smoke (signed webhooks) |
| 3 | Sign up by sending an SMS (JOIN) | Done (needs Twilio) | same; tests + smoke |
| 4 | Web sign-up portal: two fields (phone, OTP), resets after each account | Done | `/register/`; browser test "sign-up portal" |
| 5 | Password when there is no OTP | Done | Login "Use a password instead"; `AUTH_MODE=password`; tests |
| 6 | Same account and mail on web and mobile | Done (web app, installable; native apps later, as decided) | manifest + icons, served as `application/manifest+json` |
| 7 | SMS "You have received an email from <Sender>. Subject: <Subject>." only for people without the app | Done; at most one per chat every 10 minutes | `api/src/realtime/alerts.js`; smoke checks the exact wording (also for outside senders) |
| 8 | Onboarding: language → terms → phone → OTP (code filled in automatically) | Done on the web (`one-time-code` autofill; SIM-number detection needs the native apps) | `/welcome`, Terms line, Login |
| 9 | Home like Spike Mail: chats, no Inbox/Sent split, search, chips All / Unread / Attachments / Favourites, left menu, profile | Done | phone layout; browser tests |
| 10 | In a chat: subject only on new mail | Done | Writer; tests |
| 11 | Swipe right to reply | Done (phones) | `web/src/mail/Swipe.tsx`; browser test (touch) |
| 12 | Each message can be replied to once | Done, enforced by the database | `messages_reply_once`; Go, api, smoke, browser tests |
| 13 | Tap a long email for the full view | Done: 100-character previews, "Read more" | Go + browser tests |
| 14 | To/Cc locked inside a chat | Done (server-side) | Go tests |
| 15 | Full editor in the chat | Done: formatting, files, schedule, undo | Writer / Compose |
| 16 | 2+ recipients from Home make a group; later mail to one person stays one-to-one | Done (group needs a name, as decided) | Go + browser tests |
| 17 | Web: one sign-in screen (phone, OTP, one Next, Terms line), Gmail-like mailbox, profile and settings | Done | browser tests |
| 18 | Dockerised: `docker compose up -d` | Done | `docker-compose.yml` |
| 19 | People outside PhoneMail get ordinary email; their answers come back into the chat | Done (through Postfix) | `inbound.go`, `outside.go`; Go tests + smoke over SMTP |
| 20 | Addresses on an earlier domain still arrive | Done (`MAIL_LEGACY_DOMAINS`) | Go test |
| 21 | Aliases, attachments (25 MB), profile pictures with private styles | Done | tests |
| 22 | Never places calls; secrets never in the code | Done | Twilio used only for Verify, texts and answering calls; `.env` ignored |

Deliberately not in this build (by decision): Hindi and Tamil (shown, "coming soon"), the stock-glyph
avatar picker, JOIN-code/QR sign-in on the web page (JOIN by text still works), webmail/IMAP (off in the
native Android/iPhone apps (later).
