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
    -- Edugate registration status (migration 010): NULL = no code/login
    -- email yet, 'REGISTRATION_PENDING' = a code email arrived, 'REGISTERED'
    -- = a registration email arrived (never goes back). Times are the
    -- emails' sent times (messages.sent_at), latest of each kind.
    registration_status TEXT
        CHECK (registration_status IN ('REGISTRATION_PENDING', 'REGISTERED')),
    code_sent_at TIMESTAMPTZ,
    registered_at TIMESTAMPTZ,
    -- Newest Edugate document-rejection email (migration 015).
    rejected_at TIMESTAMPTZ,
    -- When the rolling daily sweep last checked this student's own mailbox
    -- (migration 008, sweep.ts); NULL = never.
    last_swept_at TIMESTAMPTZ,
    CONSTRAINT students_college_admission_unique UNIQUE (college_id, admission_id),
    CONSTRAINT students_email_lowercase CHECK (email = lower(email))
);

CREATE INDEX idx_students_central_email ON students (central_email);
CREATE INDEX idx_students_deleted_at ON students (deleted_at);
CREATE INDEX idx_students_roster_order ON students
    (central_email, (coalesce(first_name, '')), (coalesce(last_name, '')), id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_students_sweep ON students (last_swept_at NULLS FIRST, id)
    WHERE deleted_at IS NULL AND central_email IS NOT NULL AND smtp_password <> '';
CREATE INDEX idx_students_hot_code ON students (code_sent_at)
    WHERE deleted_at IS NULL AND code_sent_at IS NOT NULL;
CREATE INDEX idx_students_email_lower ON students (lower(email));
-- Roster status buckets and counts: an index-only scan (migration 015).
CREATE INDEX idx_students_roster_state ON students (central_email, college_id)
    INCLUDE (code_sent_at, registered_at, rejected_at)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_students_college_email ON students (college_id, email)
    WHERE deleted_at IS NULL;

-- Free-text search across name/email/owner/college/admission_id for
-- the admin roster page (pg_trgm ILIKE '%term%' against this concatenated
-- column).
CREATE INDEX idx_students_search_trgm ON students
    USING GIN (
        (coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
         coalesce(email, '') || ' ' || coalesce(central_email, '') || ' ' ||
         coalesce(college, '') || ' ' || coalesce(admission_id, '')) gin_trgm_ops
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
    -- How long Migadu held the email between accepting it and storing it in
    -- the mailbox, from its Received headers (migaduDelay.ts). NULL = not
    -- measured (rows from before migration 009, or unreadable headers).
    migadu_hold_seconds INTEGER,
    migadu_queue_id TEXT,
    -- The sender's own send time (Date: header) - used for ordering, since
    -- Migadu can hold mail for hours (migration 010). NULL = unknown.
    sent_at TIMESTAMPTZ,
    -- 'code' | 'login' | 'rejected' when the email matches a verified
    -- Edugate template (shared/edugate.ts), else NULL.
    edugate_kind TEXT CHECK (edugate_kind IN ('code', 'login', 'rejected')),
    CONSTRAINT messages_message_id_student_unique UNIQUE (message_id, student_email),
    CONSTRAINT messages_student_email_lowercase CHECK (student_email = lower(student_email))
);

CREATE INDEX idx_messages_central_email ON messages (central_email);
CREATE INDEX idx_messages_pending ON messages (replied, received_at DESC);
-- Supports narrowing a thread fetch to just the students matched by a name/
-- email search (see fetchMessagesForStudentEmails in thread.ts), instead of
-- scanning every message for the college.
CREATE INDEX idx_messages_student_email ON messages (student_email);
CREATE INDEX idx_messages_student_email_lower ON messages (lower(student_email), edugate_kind);

CREATE FUNCTION students_lowercase_email() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.email := lower(NEW.email);
    RETURN NEW;
END
$fn$;
CREATE TRIGGER students_lowercase_email BEFORE INSERT OR UPDATE OF email ON students
    FOR EACH ROW EXECUTE FUNCTION students_lowercase_email();

CREATE FUNCTION messages_lowercase_student_email() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.student_email := lower(NEW.student_email);
    RETURN NEW;
END
$fn$;
CREATE TRIGGER messages_lowercase_student_email BEFORE INSERT OR UPDATE OF student_email ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_lowercase_student_email();

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

-- Opening a thread reads one student's replies (migration 016).
CREATE INDEX idx_replies_student_email ON replies (student_email);

-- One row per central/operator mailbox that has logged in. Auth verifies
-- IMAP credentials live against this mailbox (see auth.ts) rather than
-- storing a separate operator password.
CREATE TABLE central_mailboxes (
    email VARCHAR(320) PRIMARY KEY,
    password TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- Incremental IMAP sync watermark (migration 004; was missing here):
    -- the last processed UID and the UIDVALIDITY it belongs to.
    last_uid BIGINT,
    uid_validity BIGINT
);

-- Login sessions (migration 011, auth.ts). Only a SHA-256 of the cookie is
-- stored; expires 7 days after login, like the cookie.
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    email VARCHAR(320) NOT NULL,
    college_id BIGINT REFERENCES colleges(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

-- Status page "Recent problems" (migration 012, systemStatus.ts). subject is
-- what gets marked solved (student email, Message-ID, or central mailbox);
-- solved rows are deleted after 7 days, all rows after 30. One open row per
-- (kind, subject); repeats bump times/last_at.
CREATE TABLE status_problems (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    times INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    source TEXT,
    detail TEXT NOT NULL,
    solved_at TIMESTAMPTZ
);

CREATE INDEX idx_status_problems_last_at ON status_problems (last_at DESC);
CREATE UNIQUE INDEX idx_status_problems_open ON status_problems (kind, subject) WHERE solved_at IS NULL;

-- How long each call to the Migadu mailbox API takes (migration 017, migaduTiming.ts):
-- operation is lookup / create / remove, ms the duration, outcome ok / refused /
-- server-error / timeout / network. Rows older than 30 days are deleted.
CREATE TABLE migadu_calls (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operation TEXT NOT NULL,
    ms INTEGER NOT NULL,
    outcome TEXT NOT NULL
);

CREATE INDEX idx_migadu_calls_at ON migadu_calls (at);

-- Keeps the student's Edugate dates right when a code/login/rejection email is
-- deleted or corrected (migration 015).
CREATE FUNCTION students_refresh_edugate_status() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
DECLARE
    old_email TEXT;
    new_email TEXT;
BEGIN
    old_email := OLD.student_email;

    IF TG_OP = 'UPDATE' AND NEW.student_email IS DISTINCT FROM OLD.student_email THEN
        new_email := NEW.student_email;
    END IF;

    -- A correction can move Edugate mail between two students. Lock both
    -- student rows in email order before either UPDATE so opposite-direction
    -- corrections cannot deadlock.
    PERFORM 1 FROM students
    WHERE email IN (old_email, new_email)
    ORDER BY email FOR UPDATE;

    UPDATE students s SET
        code_sent_at = x.code_at,
        registered_at = x.login_at,
        rejected_at = x.rejected_at,
        registration_status = CASE
            WHEN x.login_at IS NOT NULL THEN 'REGISTERED'
            WHEN x.code_at IS NOT NULL THEN 'REGISTRATION_PENDING' END
    FROM (
        SELECT max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'code') AS code_at,
               max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'login') AS login_at,
               max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'rejected') AS rejected_at
        FROM messages
        WHERE student_email = old_email AND edugate_kind IS NOT NULL
    ) x
    WHERE s.email = old_email;

    IF new_email IS NOT NULL THEN
        UPDATE students s SET
            code_sent_at = x.code_at,
            registered_at = x.login_at,
            rejected_at = x.rejected_at,
            registration_status = CASE
                WHEN x.login_at IS NOT NULL THEN 'REGISTERED'
                WHEN x.code_at IS NOT NULL THEN 'REGISTRATION_PENDING' END
        FROM (
            SELECT max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'code') AS code_at,
                   max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'login') AS login_at,
                   max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'rejected') AS rejected_at
            FROM messages
            WHERE student_email = new_email AND edugate_kind IS NOT NULL
        ) x
        WHERE s.email = new_email;
    END IF;

    RETURN NULL;
END
$fn$;

CREATE TRIGGER messages_edugate_status_delete
    AFTER DELETE ON messages
    FOR EACH ROW
    WHEN (OLD.edugate_kind IS NOT NULL)
    EXECUTE FUNCTION students_refresh_edugate_status();

CREATE TRIGGER messages_edugate_status_update
    AFTER UPDATE OF edugate_kind, sent_at, received_at, student_email ON messages
    FOR EACH ROW
    WHEN ((OLD.edugate_kind IS NOT NULL OR NEW.edugate_kind IS NOT NULL)
          AND (OLD.edugate_kind IS DISTINCT FROM NEW.edugate_kind
               OR OLD.sent_at IS DISTINCT FROM NEW.sent_at
               OR OLD.received_at IS DISTINCT FROM NEW.received_at
               OR OLD.student_email IS DISTINCT FROM NEW.student_email))
    EXECUTE FUNCTION students_refresh_edugate_status();

CREATE OR REPLACE FUNCTION students_refresh_rejected_on_email_change() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.rejected_at := (
        SELECT max(coalesce(sent_at, received_at))
        FROM messages
        WHERE student_email = NEW.email AND edugate_kind = 'rejected'
    );
    RETURN NEW;
END
$fn$;

CREATE TRIGGER students_rejected_on_email_change
    BEFORE UPDATE OF email ON students
    FOR EACH ROW
    WHEN (OLD.email IS DISTINCT FROM NEW.email)
    EXECUTE FUNCTION students_refresh_rejected_on_email_change();
