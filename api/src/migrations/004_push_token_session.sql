-- A phone's push token belongs to the sign-in session that registered it (18 Oct 2026): when that
-- session ends for any reason (signed out, "sign out everywhere", password changed, expired), the
-- token goes with it, so the phone stops showing that account's new mail even if the app could
-- not unregister itself (offline, or already signed out by the server).
ALTER TABLE mobile_push_tokens
    ADD COLUMN session_hash text REFERENCES sessions (token_hash) ON DELETE CASCADE;
CREATE INDEX mobile_push_tokens_session_idx ON mobile_push_tokens (session_hash);
