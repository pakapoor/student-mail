-- Run once after 004_step10_sync_improvements.sql.
-- Step 13: the reply composer now supports Bold/Italic formatting, which
-- needs to be preserved in conversation history, not just in the sent
-- email. body_text keeps holding the plain-text fallback (derived from the
-- sanitized HTML server-side); body_html is nullable so replies sent before
-- this change keep rendering as plain text with no backfill needed.
BEGIN;

ALTER TABLE replies
    ADD COLUMN body_html TEXT;

COMMIT;
