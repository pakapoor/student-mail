-- Run once after 011_sessions.sql, as the app role (so it owns the
-- table like every other one): psql -h 127.0.0.1 -U student_mail_app -d student_mail -f ...
-- Step 28: the status page's "Recent problems" (mailbox won't open, email
-- could not be fetched, central sync failed) move from process memory to
-- Postgres, so a restart or deploy no longer wipes them.
--   kind      - 'mailbox-failed' | 'gave-up' | 'sync-failed'
--   subject   - what the problem is about, used to mark it solved: the
--               student's email, the email's Message-ID, or the central
--               mailbox.
--   solved_at - set when the same thing next works (mailbox opens, email
--               gets stored, sync succeeds). Solved rows are deleted after
--               7 days, all rows after 30 (systemStatus.ts).
--   At most one OPEN row per (kind, subject): a repeat failure bumps
--   times / last_at / detail instead of adding a row.
-- New table only; nothing existing changes.
BEGIN;

CREATE TABLE IF NOT EXISTS status_problems (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    times INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    source TEXT,
    detail TEXT NOT NULL,
    solved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_status_problems_last_at ON status_problems (last_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_status_problems_open ON status_problems (kind, subject) WHERE solved_at IS NULL;

COMMIT;
