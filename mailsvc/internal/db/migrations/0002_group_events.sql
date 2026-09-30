-- Group activity lines shown inside a group chat ("Asha added Ravi", "Meena left",
-- "Ravi is now an admin"). Kept apart from messages: they can't be replied to,
-- searched or counted as unread.

CREATE TABLE conversation_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id bigint NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    kind            text NOT NULL
                    CHECK (kind IN ('created', 'added', 'removed', 'left', 'admin', 'not_admin')),
    actor_id        bigint REFERENCES users (id) ON DELETE SET NULL,  -- who did it; NULL = automatic
    target_id       bigint REFERENCES users (id) ON DELETE SET NULL,  -- who it happened to
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_events_chat_idx ON conversation_events (conversation_id, created_at, id);
