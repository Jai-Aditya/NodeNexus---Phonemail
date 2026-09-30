-- Mail to and from other providers (Gmail, Outlook, ...), 30 Sep. The standard interface,
-- so an existing Postfix works unchanged: Postfix hands incoming mail for our domain to
-- the mail service over SMTP (port 2525), and the mail service hands outgoing mail to Postfix,
-- which signs (DKIM) and delivers it.

-- People outside PhoneMail are "external" users: an email address instead of a phone number,
-- and no sign-in. A conversation with one is an ordinary one-to-one chat on the PhoneMail side;
-- they send and receive ordinary email. They can't be group members (decided 30 Sep).
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE users ADD COLUMN external_address text UNIQUE
    CHECK (external_address = lower(external_address) AND external_address LIKE '_%@_%');
ALTER TABLE users ADD CONSTRAINT users_phone_or_external CHECK ((phone IS NULL) <> (external_address IS NULL));
ALTER TABLE users DROP CONSTRAINT users_created_via_check,
    ADD CONSTRAINT users_created_via_check CHECK (created_via IN ('ivr', 'sms', 'portal', 'web', 'mobile', 'external'));
-- How a person's address is built: the 10 digits (+ "@" + our domain) or an outsider's whole address.
ALTER TABLE users ADD COLUMN addr_key text GENERATED ALWAYS AS (coalesce(right(phone, 10), external_address)) STORED;

-- Email waiting to go to outside recipients. A worker hands each to Postfix, so a slow or
-- stopped Postfix never holds up mail inside PhoneMail. One row per message, retried with back-off.
CREATE TABLE outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id      bigint NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at) WHERE status = 'pending';
