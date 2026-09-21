-- Run once after 001_colleges.sql. Preserve legacy records without assigning
-- colleges or application numbers; uniqueness applies within each college.
BEGIN;

ALTER TABLE students
    ADD COLUMN college_id BIGINT REFERENCES colleges(id),
    ADD COLUMN admission_id TEXT,
    ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT students_college_admission_unique
        UNIQUE (college_id, admission_id);

COMMIT;
