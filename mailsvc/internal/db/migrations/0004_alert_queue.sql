-- New-mail alerts waiting to be sent (push notification, or SMS for people without the app).
-- A row is written in the same transaction as the delivery, so an alert can't be lost:
-- the API service sends them at a pace Twilio accepts, retries failures, and marks each done.

CREATE TABLE alert_queue (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE, -- who to alert
    conversation_id bigint NOT NULL,   -- no foreign keys on these three: an alert is short-lived
    message_id      bigint NOT NULL,   -- and must not block deleting the chat or message
    sender_id       bigint,
    subject         text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'push', 'sms', 'skipped', 'failed')),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),  -- also a lease while being sent
    done_at         timestamptz,
    last_error      text
);
-- The sender's work list.
CREATE INDEX alert_queue_due_idx ON alert_queue (next_attempt_at) WHERE status = 'pending';
-- "Did this person get an SMS for this chat recently?" (one SMS per chat per few minutes).
CREATE INDEX alert_queue_recent_sms_idx ON alert_queue (user_id, conversation_id, done_at) WHERE status = 'sms';
