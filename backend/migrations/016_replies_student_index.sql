-- Step 31d: opening a thread reads one student's replies (WHERE student_email = $1).
-- Without this index that read scans the whole replies table. Index only; no data is
-- changed. Safe to re-run, and harmless to the old code.
SET lock_timeout = '5s';
BEGIN;

CREATE INDEX IF NOT EXISTS idx_replies_student_email ON replies (student_email);

COMMIT;

ANALYZE replies;
