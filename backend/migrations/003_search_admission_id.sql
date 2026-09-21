-- Run once after 002_student_identity.sql. Rebuilds the admin roster's
-- trigram search index to include admission_id, matching the expression
-- searchAdminStudents now filters on - Postgres only uses an expression
-- index when the WHERE clause expression matches it exactly.
BEGIN;

DROP INDEX IF EXISTS idx_students_search_trgm;

CREATE INDEX idx_students_search_trgm ON students
    USING GIN (
        (coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
         coalesce(email, '') || ' ' || coalesce(central_email, '') || ' ' ||
         coalesce(college, '') || ' ' || coalesce(year_enrolled::text, '') || ' ' ||
         coalesce(admission_id, '')) gin_trgm_ops
    );

COMMIT;
