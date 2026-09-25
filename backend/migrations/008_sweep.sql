-- Run once (after 010 on existing databases - 008 was reserved for this and
-- is applied last in practice; it only adds a column and an index).
-- Step 17 A: rolling daily sweep of every student's own mailbox (sweep.ts).
-- students.last_swept_at = when the sweep last checked this student's
-- mailbox; the next batch takes the oldest (never-swept first), so the
-- sweep resumes where it left off after restarts. Nullable, no default:
-- existing rows stay NULL (= "never swept", swept first).
BEGIN;

ALTER TABLE students ADD COLUMN last_swept_at TIMESTAMPTZ;

CREATE INDEX idx_students_last_swept
    ON students (last_swept_at NULLS FIRST)
    WHERE deleted_at IS NULL;

COMMIT;
