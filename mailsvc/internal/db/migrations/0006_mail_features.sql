-- Gmail-style features (30 Sep): archive, snooze, mute, send later (undo send and
-- scheduled send), forward from a draft, blocking, reactions, signatures.

-- Archive: a chat leaves Home until new mail arrives in it. The existing "hidden" flag
-- already works that way (every delivery clears it), so archiving just sets it.
-- Snooze: a chat leaves Home until snoozed_until, then comes back to the top, unread.
-- Mute: new mail in the chat arrives as usual but sends no push or SMS alert.
ALTER TABLE user_conversations
    ADD COLUMN snoozed_until timestamptz,
    ADD COLUMN muted boolean NOT NULL DEFAULT false;
CREATE INDEX user_conversations_snoozed_idx ON user_conversations (snoozed_until) WHERE snoozed_until IS NOT NULL;

-- Send later: a draft with send_at is sent by the mail service at that time. Undo send
-- is the same thing a few seconds ahead: "Undo" takes the draft back before it goes.
-- If sending fails then (say the group was left), the draft stays with send_error set.
ALTER TABLE drafts
    ADD COLUMN send_at timestamptz,
    ADD COLUMN send_error text NOT NULL DEFAULT '',
    ADD COLUMN forwarded_from_id bigint REFERENCES messages (id) ON DELETE SET NULL;
CREATE INDEX drafts_due_idx ON drafts (send_at) WHERE send_at IS NOT NULL;
CREATE INDEX drafts_forwarded_idx ON drafts (forwarded_from_id) WHERE forwarded_from_id IS NOT NULL;

-- Blocking: mail sent straight to you by someone you blocked goes to your Spam, with no
-- alert. (Group mail is not affected: the group decides who is in it.)
CREATE TABLE blocks (
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blocked_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, blocked_id),
    CHECK (user_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

-- Reactions: one emoji per person per message, visible to everyone who has the message.
CREATE TABLE message_reactions (
    message_id bigint NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    emoji      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_reactions_user_idx ON message_reactions (user_id);

-- Settings the web and phone apps share: a signature added to new emails, and how many
-- seconds "Undo" is offered after pressing Send (0 = send at once).
ALTER TABLE users
    ADD COLUMN signature text NOT NULL DEFAULT '' CHECK (length(signature) <= 1000),
    ADD COLUMN undo_send_seconds integer NOT NULL DEFAULT 10 CHECK (undo_send_seconds BETWEEN 0 AND 30);
