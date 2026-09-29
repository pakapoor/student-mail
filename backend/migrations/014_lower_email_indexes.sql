-- Step 31 (draft): indexes so the student/message lookups stay fast as the
-- number of students and messages grows. Index and constraint changes only:
-- no data is changed. Safe to re-run.
--
-- The app compares emails as lower(a) = lower(b) in many queries. A plain
-- index on the column cannot serve that, so each query scanned the whole
-- table for every row (students x messages). Emails are always stored in
-- lower case (the import and the mail sync both lowercase them), so the
-- CHECK constraints below make that rule the database's, and a stray capital
-- fails loudly at insert time instead of silently missing a lookup.
SET lock_timeout = '5s';
BEGIN;

-- 1. students by lower(email): console list subquery, names lookup,
--    registration update on every code/login email, roster joins.
CREATE INDEX IF NOT EXISTS idx_students_email_lower ON students (lower(email));

-- 2. messages by lower(student_email) (+ kind): roster "latest rejection"
--    lookup, thread-view Edugate lookups, code-alert login lookup.
CREATE INDEX IF NOT EXISTS idx_messages_student_email_lower
    ON messages (lower(student_email), edugate_kind);

-- 3. roster paging in name order (matches ORDER BY in studentsAdmin.ts);
--    replaces the unused (first_name, last_name, id) index, which never
--    matched the coalesce() the query sorts by.
CREATE INDEX IF NOT EXISTS idx_students_roster_order
    ON students (central_email, (coalesce(first_name, '')), (coalesce(last_name, '')), id)
    WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS idx_students_sort;

-- 4. hot list (every 30 s): students with a code that may still be live.
CREATE INDEX IF NOT EXISTS idx_students_hot_code
    ON students (code_sent_at)
    WHERE deleted_at IS NULL AND code_sent_at IS NOT NULL;

-- 5. sweep: next batch (ordered) and the mailbox count, both on the same
--    predicate; replaces the narrower idx_students_last_swept.
CREATE INDEX IF NOT EXISTS idx_students_sweep
    ON students (last_swept_at NULLS FIRST, id)
    WHERE deleted_at IS NULL AND central_email IS NOT NULL AND smtp_password <> '';
DROP INDEX IF EXISTS idx_students_last_swept;

-- 6. students of one college by email (active only): the "is this message's
--    student in the selected college" check every console query makes, so
--    it can be answered from an index instead of scanning the students table.
CREATE INDEX IF NOT EXISTS idx_students_college_email
    ON students (college_id, email)
    WHERE deleted_at IS NULL;

-- 7. the lower-case rule, enforced twice: a trigger silently lowercases an
--    email on insert (or when the email is changed), so an accidental capital
--    never reaches the table; the CHECK constraints behind it guarantee the
--    rule even if the trigger were ever dropped.
CREATE OR REPLACE FUNCTION students_lowercase_email() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.email := lower(NEW.email);
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION messages_lowercase_student_email() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.student_email := lower(NEW.student_email);
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS students_lowercase_email ON students;
CREATE TRIGGER students_lowercase_email
    BEFORE INSERT OR UPDATE OF email ON students
    FOR EACH ROW EXECUTE FUNCTION students_lowercase_email();

DROP TRIGGER IF EXISTS messages_lowercase_student_email ON messages;
CREATE TRIGGER messages_lowercase_student_email
    BEFORE INSERT OR UPDATE OF student_email ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_lowercase_student_email();

DO $$
DECLARE
    bad_students BIGINT;
    bad_messages BIGINT;
BEGIN
    -- The CHECK constraints below validate every existing row. Say clearly
    -- what is wrong instead of failing with a bare constraint error.
    SELECT count(*) INTO bad_students FROM students WHERE email <> lower(email);
    SELECT count(*) INTO bad_messages FROM messages WHERE student_email <> lower(student_email);

    IF bad_students > 0 OR bad_messages > 0 THEN
        RAISE EXCEPTION 'migration 014 stopped: % student email(s) and % message student_email value(s) contain capitals; lowercase them first',
            bad_students, bad_messages;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_email_lowercase') THEN
        ALTER TABLE students ADD CONSTRAINT students_email_lowercase CHECK (email = lower(email));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_student_email_lowercase') THEN
        ALTER TABLE messages ADD CONSTRAINT messages_student_email_lowercase CHECK (student_email = lower(student_email));
    END IF;
END $$;

COMMIT;

ANALYZE students;
ANALYZE messages;
