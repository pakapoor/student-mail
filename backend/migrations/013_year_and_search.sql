-- Step 30: every student enrolled so far started in 2026 (the import used
-- to have no year column, so year_enrolled was left empty), and the year is
-- no longer part of the searchable text (all students would match "2026").
-- Run once as the app role, before the new backend code is started.
-- Safe to re-run: only fills empty years; the index is dropped and rebuilt.
-- Postgres only uses an expression index when the query's expression
-- matches it exactly, so the rebuilt index matches searchAdminStudents,
-- findMatchingStudentEmails and findSearchMatches (no year).
BEGIN;

UPDATE students
SET year_enrolled = 2026
WHERE year_enrolled IS NULL AND deleted_at IS NULL;

DROP INDEX IF EXISTS idx_students_search_trgm;

CREATE INDEX idx_students_search_trgm ON students
    USING GIN (
        (coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
         coalesce(email, '') || ' ' || coalesce(central_email, '') || ' ' ||
         coalesce(college, '') || ' ' || coalesce(admission_id, '')) gin_trgm_ops
    );

COMMIT;
