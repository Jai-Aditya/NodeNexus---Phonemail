-- Sessions of the phone apps (Android / iPhone, signing in with client "mobile" and a Bearer token). A person
-- signed in to an app gets live updates there, so they don't get "You have received an email" texts: the brief
-- sends those only to people without the app.
ALTER TABLE sessions ADD COLUMN app boolean NOT NULL DEFAULT false;
CREATE INDEX sessions_app_user_idx ON sessions (user_id) WHERE app;