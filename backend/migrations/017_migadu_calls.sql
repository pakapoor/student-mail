-- Step 43: how long each call to the Migadu mailbox API takes (migadu.ts), kept for
-- 30 days so the status page can graph it and the call timeout can be set from real
-- data. One row per call: what it was (lookup / create / remove), how long it took
-- in milliseconds, and how it ended (ok, refused, server-error, timeout, network).
-- Holds no names, addresses or passwords. Run once as the app role, before the new
-- backend code is started. Safe to re-run and harmless to the old code.
SET lock_timeout = '5s';
BEGIN;

CREATE TABLE IF NOT EXISTS migadu_calls (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operation TEXT NOT NULL,
    ms INTEGER NOT NULL,
    outcome TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_migadu_calls_at ON migadu_calls (at);

COMMIT;
