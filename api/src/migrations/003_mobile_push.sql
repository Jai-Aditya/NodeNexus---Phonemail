-- Push tokens of the phone apps (17 Oct 2026): iPhone through Apple (APNs), Android through
-- Firebase (FCM). Like a browser subscription, a user with one has users.has_push = true and
-- gets push notifications instead of SMS alerts. A token belongs to one signed-in person at a
-- time: signing in as someone else on the same phone moves it.
CREATE TABLE mobile_push_tokens (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
    token        text NOT NULL UNIQUE,
    sandbox      boolean NOT NULL DEFAULT false, -- iOS development builds use Apple's sandbox service
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_push_tokens_user_idx ON mobile_push_tokens (user_id);
