-- Run once after 005_reply_body_html.sql.
-- The college's correct name is KRMA CENTRAL, not KSMA CENTRAL (a naming
-- error caught after Steps 2-9 already used the wrong name). This only
-- renames the display name (colleges.name, students.college free-text
-- column, and the "KSMA" abbreviation baked into the 5 test students'
-- name/last_name fields as a label). It deliberately does NOT touch any
-- mailbox email address (central.ksma@..., test.ksma1-5@...,
-- sample.ksma.*@...) - those are real provisioned Migadu mailboxes whose
-- addresses are live login credentials, not display text; renaming them
-- would require actually recreating the mailboxes at Migadu, which is a
-- separate real-world action, not a database update.
BEGIN;

UPDATE colleges SET name = 'KRMA CENTRAL' WHERE name = 'KSMA CENTRAL';

UPDATE students SET college = 'KRMA CENTRAL' WHERE college = 'KSMA CENTRAL';

UPDATE students
SET name = replace(name, 'KSMA', 'KRMA'),
    last_name = replace(last_name, 'KSMA', 'KRMA')
WHERE name LIKE '%KSMA%' OR last_name LIKE '%KSMA%';

COMMIT;
