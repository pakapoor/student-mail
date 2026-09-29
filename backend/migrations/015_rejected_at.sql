-- Step 31: students.rejected_at - the newest Edugate document-rejection email,
-- kept on the student like code_sent_at and registered_at (migration 010).
-- The roster used to find it with a per-student lookup into messages; now it
-- classifies students from the students table alone, and its status counts
-- are answered by an index-only scan of the covering partial index below.
-- Run once as the app role, before the new backend code is started (the new
-- code reads and writes the column). Safe to re-run.
SET lock_timeout = '5s';
BEGIN;

ALTER TABLE students ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

-- Backfill from the stored rejection emails (sent time, falling back to the
-- arrival time, the same rule the app uses). Rows already correct are skipped.
UPDATE students s
SET rejected_at = x.at
FROM (
    SELECT lower(student_email) AS email, max(coalesce(sent_at, received_at)) AS at
    FROM messages
    WHERE edugate_kind = 'rejected'
    GROUP BY 1
) x
WHERE lower(s.email) = x.email
  AND s.rejected_at IS DISTINCT FROM x.at;

-- Re-running this migration also clears a rejection date whose rejection email
-- no longer exists (so it can be used to repair after emails were removed).
UPDATE students s
SET rejected_at = NULL
WHERE s.rejected_at IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM messages m
      WHERE lower(m.student_email) = lower(s.email) AND m.edugate_kind = 'rejected'
  );

-- The student's Edugate dates (code_sent_at, registered_at, rejected_at and the
-- status) are written when an email arrives. When a code, login or rejection
-- email is deleted, or corrected (its kind or times change), they must follow,
-- or the roster keeps showing a state the mailbox no longer supports.
CREATE OR REPLACE FUNCTION students_refresh_edugate_status() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
DECLARE
    old_email TEXT;
    new_email TEXT;
BEGIN
    old_email := OLD.student_email;

    IF TG_OP = 'UPDATE' AND NEW.student_email IS DISTINCT FROM OLD.student_email THEN
        new_email := NEW.student_email;
    END IF;

    -- A correction can move Edugate mail between two students. Lock both
    -- student rows in email order before either UPDATE so opposite-direction
    -- corrections cannot deadlock.
    PERFORM 1 FROM students
    WHERE email IN (old_email, new_email)
    ORDER BY email FOR UPDATE;

    UPDATE students s SET
        code_sent_at = x.code_at,
        registered_at = x.login_at,
        rejected_at = x.rejected_at,
        registration_status = CASE
            WHEN x.login_at IS NOT NULL THEN 'REGISTERED'
            WHEN x.code_at IS NOT NULL THEN 'REGISTRATION_PENDING' END
    FROM (
        SELECT max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'code') AS code_at,
               max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'login') AS login_at,
               max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'rejected') AS rejected_at
        FROM messages
        WHERE student_email = old_email AND edugate_kind IS NOT NULL
    ) x
    WHERE s.email = old_email;

    IF new_email IS NOT NULL THEN
        UPDATE students s SET
            code_sent_at = x.code_at,
            registered_at = x.login_at,
            rejected_at = x.rejected_at,
            registration_status = CASE
                WHEN x.login_at IS NOT NULL THEN 'REGISTERED'
                WHEN x.code_at IS NOT NULL THEN 'REGISTRATION_PENDING' END
        FROM (
            SELECT max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'code') AS code_at,
                   max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'login') AS login_at,
                   max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'rejected') AS rejected_at
            FROM messages
            WHERE student_email = new_email AND edugate_kind IS NOT NULL
        ) x
        WHERE s.email = new_email;
    END IF;

    RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS messages_edugate_status_delete ON messages;
CREATE TRIGGER messages_edugate_status_delete
    AFTER DELETE ON messages
    FOR EACH ROW
    WHEN (OLD.edugate_kind IS NOT NULL)
    EXECUTE FUNCTION students_refresh_edugate_status();

DROP TRIGGER IF EXISTS messages_edugate_status_update ON messages;
CREATE TRIGGER messages_edugate_status_update
    AFTER UPDATE OF edugate_kind, sent_at, received_at, student_email ON messages
    FOR EACH ROW
    WHEN ((OLD.edugate_kind IS NOT NULL OR NEW.edugate_kind IS NOT NULL)
          AND (OLD.edugate_kind IS DISTINCT FROM NEW.edugate_kind
               OR OLD.sent_at IS DISTINCT FROM NEW.sent_at
               OR OLD.received_at IS DISTINCT FROM NEW.received_at
               OR OLD.student_email IS DISTINCT FROM NEW.student_email))
    EXECUTE FUNCTION students_refresh_edugate_status();

-- Changing a student's email points them at a different mailbox, so the
-- rejection date cached on the student must follow the mail under the new
-- address (the other Edugate dates are refreshed the same way when an email
-- is deleted or corrected, above).
CREATE OR REPLACE FUNCTION students_refresh_rejected_on_email_change() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.rejected_at := (
        SELECT max(coalesce(sent_at, received_at))
        FROM messages
        WHERE student_email = NEW.email AND edugate_kind = 'rejected'
    );
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS students_rejected_on_email_change ON students;
CREATE TRIGGER students_rejected_on_email_change
    BEFORE UPDATE OF email ON students
    FOR EACH ROW
    WHEN (OLD.email IS DISTINCT FROM NEW.email)
    EXECUTE FUNCTION students_refresh_rejected_on_email_change();

-- Everything the roster's status buckets and counts read, for active
-- students only, so a count never has to visit the table.
CREATE INDEX IF NOT EXISTS idx_students_roster_state
    ON students (central_email, college_id)
    INCLUDE (code_sent_at, registered_at, rejected_at)
    WHERE deleted_at IS NULL;

COMMIT;

-- VACUUM sets the visibility map so the covering index can answer counts
-- without visiting the table (the backfill above just touched every row).
VACUUM (ANALYZE) students;
