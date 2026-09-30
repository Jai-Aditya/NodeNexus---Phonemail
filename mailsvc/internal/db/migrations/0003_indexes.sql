-- Indexes for the hourly clean-up, foreign-key checks and storage quotas.
-- Without them each of these queries reads a whole table.

-- Clean-up empties Trash older than 30 days: find those pointers directly.
CREATE INDEX mailbox_trash_idx ON mailbox (deleted_at) WHERE folder = 'trash';

-- Deleting a message makes PostgreSQL check every row that refers to it
-- (ON DELETE SET NULL / RESTRICT). These columns had no index, so each check scanned.
CREATE INDEX messages_forwarded_idx ON messages (forwarded_from_id) WHERE forwarded_from_id IS NOT NULL;
CREATE INDEX drafts_parent_idx ON drafts (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX message_recipients_group_idx ON message_recipients (group_id) WHERE group_id IS NOT NULL;

-- A user's sent messages: storage quota, and deleting a user.
CREATE INDEX messages_sender_idx ON messages (sender_id);
