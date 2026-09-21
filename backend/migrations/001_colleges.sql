-- Add the approved colleges without modifying existing students or mail.
BEGIN;

CREATE TABLE IF NOT EXISTS colleges (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO colleges (name) VALUES
    ('KSMA CENTRAL'), ('IHSM CENTRAL'), ('IHSM ELITE')
ON CONFLICT (name) DO NOTHING;

COMMIT;
