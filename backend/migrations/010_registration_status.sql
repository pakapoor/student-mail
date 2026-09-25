-- Run once after 009_migadu_hold.sql. (008 stays reserved for the not-yet-
-- built rolling sweep.)
-- Step 18 phase 1: Edugate registration status per student.
--   messages.sent_at       - the sender's own send time (Date: header).
--                            Ordering uses this, not received_at: Migadu can
--                            hold mail for hours, so arrival order can lie.
--   messages.edugate_kind  - 'code' | 'login' | 'rejected' when the email
--                            matches a verified template (shared/edugate.ts),
--                            else NULL.
--   students.registration_status - NULL (no Edugate code/login email yet),
--                            'REGISTRATION_PENDING' (a code email arrived),
--                            'REGISTERED' (a registration email arrived;
--                            never goes back to pending).
--   students.code_sent_at  - sent time of the latest code email.
--   students.registered_at - sent time of the latest registration email.
-- All nullable, no defaults: Postgres adds them without rewriting the tables,
-- and nothing existing changes. Existing rows are filled afterwards by the
-- one-off scripts/backfill-edugate-status.ts (dry run first, then --apply).
BEGIN;

ALTER TABLE messages
    ADD COLUMN sent_at TIMESTAMPTZ,
    ADD COLUMN edugate_kind TEXT
        CHECK (edugate_kind IN ('code', 'login', 'rejected'));

ALTER TABLE students
    ADD COLUMN registration_status TEXT
        CHECK (registration_status IN ('REGISTRATION_PENDING', 'REGISTERED')),
    ADD COLUMN code_sent_at TIMESTAMPTZ,
    ADD COLUMN registered_at TIMESTAMPTZ;

COMMIT;
