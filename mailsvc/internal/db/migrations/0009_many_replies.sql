-- Many replies (18 Oct 2026): the hackathon's "reply once per email" rule is gone. Anyone may
-- answer an email as often as they like; each answer is its own reply under that email.
-- mailbox.is_replied stays: it now means "you have replied to this at least once".

DROP INDEX IF EXISTS messages_reply_once;

-- The unique index also served "the replies to this email" lookups.
CREATE INDEX IF NOT EXISTS messages_parent_idx ON messages (parent_id, sender_id) WHERE parent_id IS NOT NULL;
