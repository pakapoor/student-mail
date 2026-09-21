-- Run once after 003_search_admission_id.sql.
--
-- 1. Per-mailbox IMAP UID watermark, replacing the "always refetch the last
--    50 messages by sequence number" approach - that has a hard ceiling
--    (more than 50 new messages between syncs are silently never fetched,
--    not delayed) and re-parses full message source on every run even when
--    nothing changed.
-- 2. messages.message_id's uniqueness moves from global to
--    (message_id, student_email): a single external message sent to
--    several students (each forwarding independently to the same central
--    mailbox) must be recorded as a separate row per student, since each
--    student's copy is its own tracked conversation. The prior global
--    UNIQUE(message_id) meant only the first matching student's copy was
--    ever recorded and the rest silently vanished.
BEGIN;

ALTER TABLE central_mailboxes
    ADD COLUMN last_uid BIGINT,
    ADD COLUMN uid_validity BIGINT;

ALTER TABLE messages
    DROP CONSTRAINT messages_message_id_key,
    ADD CONSTRAINT messages_message_id_student_unique
        UNIQUE (message_id, student_email);

COMMIT;
