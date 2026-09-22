-- Student Mail Console - database schema
--
-- Recreates the schema from scratch. Run against an empty database, e.g.:
--   createdb student_mail
--   psql -h 127.0.0.1 -U student_mail_app -d student_mail -f schema.sql
--
-- This mirrors the live schema exactly (dumped via pg_dump --schema-only and
-- rewritten by hand for readability); update it alongside any future ALTER
-- TABLE so it never drifts from what's actually running.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE colleges (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO colleges (name) VALUES
    ('KSMA CENTRAL'), ('IHSM CENTRAL'), ('IHSM ELITE');

-- One row per student mailbox (e.g. test.student11@pilot.system-design.in).
-- Global directory across every central mailbox/operator - central_email is
-- just "who currently manages this student's mail", not a tenant boundary.
CREATE TABLE students (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(320) UNIQUE NOT NULL,
    smtp_password TEXT NOT NULL,
    name TEXT,
    first_name TEXT,
    last_name TEXT,
    college TEXT,
    year_enrolled INTEGER,
    central_email VARCHAR(320),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- Soft delete: NULL = active. Deleted students (and their messages) are
    -- hidden everywhere in the console until restored, but never purged.
    deleted_at TIMESTAMPTZ,
    -- Nullable for retained legacy records until explicitly assigned.
    college_id BIGINT REFERENCES colleges(id),
    admission_id TEXT,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT students_college_admission_unique UNIQUE (college_id, admission_id)
);

CREATE INDEX idx_students_central_email ON students (central_email);
CREATE INDEX idx_students_deleted_at ON students (deleted_at);
CREATE INDEX idx_students_sort ON students (first_name, last_name, id);

-- Free-text search across name/email/owner/college/year/admission_id for
-- the admin roster page (pg_trgm ILIKE '%term%' against this concatenated
-- column).
CREATE INDEX idx_students_search_trgm ON students
    USING GIN (
        (coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
         coalesce(email, '') || ' ' || coalesce(central_email, '') || ' ' ||
         coalesce(college, '') || ' ' || coalesce(year_enrolled::text, '') || ' ' ||
         coalesce(admission_id, '')) gin_trgm_ops
    );

-- One row per individual incoming message (the unit of reply-tracking is the
-- Message-ID, not the thread - a new message in an existing thread starts
-- out unreplied even if earlier messages in the same thread were answered).
-- Uniqueness is (message_id, student_email), not message_id alone: a single
-- external message sent to several students at once (each forwarding
-- independently to the same central mailbox) is recorded as one row per
-- student, since each student's copy is its own tracked conversation.
CREATE TABLE messages (
    id BIGSERIAL PRIMARY KEY,
    message_id TEXT NOT NULL,
    student_email VARCHAR(320) NOT NULL,
    sender_email VARCHAR(320) NOT NULL,
    subject TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW(),
    replied BOOLEAN DEFAULT FALSE,
    replied_at TIMESTAMPTZ,
    body_text TEXT,
    body_html TEXT,
    in_reply_to TEXT,
    reference_ids TEXT[],
    -- True when an operator dismissed this message via "Mark as handled"
    -- (only offered when the message contains a link) instead of replying.
    handled_without_reply BOOLEAN DEFAULT FALSE,
    central_email VARCHAR(320),
    CONSTRAINT messages_message_id_student_unique UNIQUE (message_id, student_email)
);

CREATE INDEX idx_messages_central_email ON messages (central_email);
CREATE INDEX idx_messages_pending ON messages (replied, received_at DESC);
-- Supports narrowing a thread fetch to just the students matched by a name/
-- email search (see fetchMessagesForStudentEmails in thread.ts), instead of
-- scanning every message for the college.
CREATE INDEX idx_messages_student_email ON messages (student_email);

-- One row per outgoing reply actually sent (only inserted after SMTP send
-- succeeds - see reply.ts's claim-before-send logic).
CREATE TABLE replies (
    id BIGSERIAL PRIMARY KEY,
    incoming_message_id TEXT NOT NULL,
    student_email VARCHAR(320) NOT NULL,
    recipient_email VARCHAR(320) NOT NULL,
    sent_message_id TEXT,
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    attachment_count INTEGER DEFAULT 0,
    body_text TEXT,
    -- Sanitized rich-text HTML (Bold/Italic only - see sanitizeReplyHtml.ts).
    -- Nullable: replies sent before Step 13 have none and render as plain
    -- text from body_text, with no backfill needed.
    body_html TEXT
);

-- One row per central/operator mailbox that has logged in. Auth verifies
-- IMAP credentials live against this mailbox (see auth.ts) rather than
-- storing a separate operator password.
CREATE TABLE central_mailboxes (
    email VARCHAR(320) PRIMARY KEY,
    password TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
