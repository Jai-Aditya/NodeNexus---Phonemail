-- Custom folders (17 Oct 2026): each person's own named folders. A chat is filed in at most one
-- of them (user_conversations.folder_id). Filing a chat also archives it, so it leaves Home;
-- new mail brings it back to Home while it stays in its folder. Deleting a folder leaves its
-- chats archived (they are still in All mail).

CREATE TABLE user_folders (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
    created_at timestamptz NOT NULL DEFAULT now()
);
-- One folder per name per person, whatever the capitals.
CREATE UNIQUE INDEX user_folders_name_uniq ON user_folders (user_id, lower(name));

ALTER TABLE user_conversations
    ADD COLUMN folder_id bigint REFERENCES user_folders (id) ON DELETE SET NULL;
CREATE INDEX user_conversations_folder_idx
    ON user_conversations (user_id, folder_id, last_message_at DESC) WHERE folder_id IS NOT NULL;
