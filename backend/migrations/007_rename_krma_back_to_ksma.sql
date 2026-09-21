-- Run once after 006_rename_ksma_to_krma.sql.
-- Reverts 006: the customer confirmed after the demo that KSMA CENTRAL was
-- the correct name all along. Same scope/rationale as 006, just inverted:
-- only the display name (colleges.name, students.college free-text column,
-- and the "KRMA" label baked into the 5 test students' name/last_name
-- fields) changes. Mailbox email addresses were never touched by 006 either
-- (they already say "ksma"), so nothing to revert there.
BEGIN;

UPDATE colleges SET name = 'KSMA CENTRAL' WHERE name = 'KRMA CENTRAL';

UPDATE students SET college = 'KSMA CENTRAL' WHERE college = 'KRMA CENTRAL';

UPDATE students
SET name = replace(name, 'KRMA', 'KSMA'),
    last_name = replace(last_name, 'KRMA', 'KSMA')
WHERE name LIKE '%KRMA%' OR last_name LIKE '%KRMA%';

COMMIT;
