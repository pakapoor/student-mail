-- Run once after 007_rename_krma_back_to_ksma.sql. (008 is reserved for the
-- not-yet-built Step 17 rolling sweep's students.last_swept_at.)
-- Step 17: record how long Migadu held each new email between accepting it
-- and storing it in the mailbox (from its Received headers; see
-- migaduDelay.ts), so incidents like 25 Sep 2026 can be queried later with
-- queue IDs for Migadu support. Both columns are nullable with no default:
-- existing rows stay NULL (no backfill, by decision), and Postgres adds
-- them without rewriting the table. NULL = not measured.
BEGIN;

ALTER TABLE messages
    ADD COLUMN migadu_hold_seconds INTEGER,
    ADD COLUMN migadu_queue_id TEXT;

COMMIT;
