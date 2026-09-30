-- Tables owned by the API service. (users and aliases are created by the mail
-- service's migration; the API service is the one that writes to them.)

-- Logged-in sessions. Only a SHA-256 of the cookie value is stored, so a leaked
-- database can't be used to log in.
CREATE TABLE sessions (
    token_hash   text PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    user_agent   text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- One-time codes for AUTH_MODE=console (Twilio Verify keeps its own codes).
CREATE TABLE otp_codes (
    phone      text PRIMARY KEY,
    code_hash  text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts   integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Browser push subscriptions. A user with at least one has users.has_push = true
-- and gets push notifications instead of SMS alerts.
CREATE TABLE push_subscriptions (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint   text NOT NULL UNIQUE,
    p256dh     text NOT NULL,
    auth       text NOT NULL,
    user_agent text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Small key/value settings, e.g. the generated VAPID keys for web push.
CREATE TABLE app_settings (
    key   text PRIMARY KEY,
    value jsonb NOT NULL
);
