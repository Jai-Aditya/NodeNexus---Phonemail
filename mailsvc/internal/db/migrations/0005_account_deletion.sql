-- Deleting an account (decided 30 Sep): the person's phone number, profile, aliases,
-- sessions and their own copies of mail are erased; mail they sent stays with the people
-- who received it, shown as from "Deleted account". So messages, and the To/Cc/Bcc lists
-- that name them, keep their rows with the person's id set to NULL.

ALTER TABLE messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE messages DROP CONSTRAINT messages_sender_id_fkey,
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE message_recipients DROP CONSTRAINT message_recipients_user_id_fkey,
    ADD CONSTRAINT message_recipients_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;
-- A recipient is a person or a group; both empty now means "a person who deleted their account".
ALTER TABLE message_recipients DROP CONSTRAINT message_recipients_check,
    ADD CONSTRAINT message_recipients_check CHECK (num_nonnulls(user_id, group_id) <= 1);
