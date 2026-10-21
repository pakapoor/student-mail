-- Step 49: add the college KYRGYZ NATIONAL UNIVERSITY. Additive, safe to re-run.
BEGIN;

INSERT INTO colleges (name) VALUES
    ('KYRGYZ NATIONAL UNIVERSITY')
ON CONFLICT (name) DO NOTHING;

COMMIT;
