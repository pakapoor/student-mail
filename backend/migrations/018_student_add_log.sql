-- Step 48: (1) students.mailbox_confirmed_at - when a TEST email was seen arriving in
-- the student's mailbox. A student made by Add students starts with NULL and is
-- hidden from staff screens until it is set; every existing student (and anyone the
-- old code or the CSV import inserts) gets the default, so nobody already on the list
-- disappears. (2) the Add students log on the status page: one row per event of
-- adding a student (mailbox created / reused / removed, student saved / skipped /
-- failed, test email sent / received / not received), with who did it (central
-- mailbox, college, IP) and the student (name, Application No, email) in `details`.
-- Never a password. Kept for 30 days. Run once as the app role, before the new
-- backend code is started. Safe to re-run and harmless to the old code.
SET lock_timeout = '5s';
BEGIN;

-- now() is fixed for the statement, so this fills every existing row without a
-- table rewrite.
ALTER TABLE students ADD COLUMN IF NOT EXISTS mailbox_confirmed_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS student_add_log (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_student_add_log_at ON student_add_log (at);

COMMIT;
