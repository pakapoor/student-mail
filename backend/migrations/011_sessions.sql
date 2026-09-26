-- Run once after 010_registration_status.sql, as the app role (so it owns the
-- table like every other one): psql -h 127.0.0.1 -U student_mail_app -d student_mail -f ...
-- Step 25: login sessions move from process memory to Postgres, so a backend
-- restart (deploy, crash, reboot) no longer logs every staff member out -
-- which also left open consoles silently without live updates.
--   token_hash - SHA-256 of the session cookie; the cookie itself is never
--                stored, so a DB dump can't be replayed as a login.
--   college_id - the college picked after login (NULL until picked).
--   expires_at - 7 days after login, same as the cookie.
-- New table only; nothing existing changes.
BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    email VARCHAR(320) NOT NULL,
    college_id BIGINT REFERENCES colleges(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

COMMIT;
