import type { PoolClient } from "pg";
import { db } from "./db.js";

// Edugate registration status per student (migration 010):
//   NULL                  - no Edugate code/registration email yet
//   REGISTRATION_PENDING  - a verification-code email arrived
//   REGISTERED            - a registration (login + password) email arrived
// code_sent_at / registered_at are the LATEST email of each kind, by the
// email's own sent time - Migadu can hold mail for hours, so arrival order
// isn't trustworthy. REGISTERED never goes back to pending: a code that
// arrives after registration (e.g. the student asked for another one) only
// moves code_sent_at forward.
// rejected_at (migration 015) is the latest document-rejection email, same
// rule; a rejection never changes registration_status. Keeping it on the
// student lets the roster classify students without touching messages.

// One new email for a student (called after it's stored). Only code, login
// and rejection emails affect the status.
export async function applyRegistrationEvent(
    studentEmail: string,
    kind: "code" | "login" | "rejected",
    sentAt: Date | string,
    connection: Pick<PoolClient, "query"> = db
): Promise<void> {
    await connection.query(
        `
        UPDATE students SET
            code_sent_at = CASE WHEN $2 = 'code'
                THEN GREATEST(code_sent_at, $3::timestamptz) ELSE code_sent_at END,
            registered_at = CASE WHEN $2 = 'login'
                THEN GREATEST(registered_at, $3::timestamptz) ELSE registered_at END,
            rejected_at = CASE WHEN $2 = 'rejected'
                THEN GREATEST(rejected_at, $3::timestamptz) ELSE rejected_at END,
            registration_status = CASE
                WHEN $2 = 'rejected' THEN registration_status
                WHEN $2 = 'login' OR registration_status = 'REGISTERED' THEN 'REGISTERED'
                ELSE 'REGISTRATION_PENDING' END
        WHERE lower(email) = lower($1)
        `,
        [studentEmail, kind, sentAt]
    );
}

// Recomputes every student's status from their stored emails - used by the
// one-off backfill, and safe to re-run: the result only depends on the
// messages table (edugate_kind + sent_at, falling back to received_at).
export const RECOMPUTE_ALL_SQL = `
    WITH x AS (
        SELECT lower(student_email) AS email,
               max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'code') AS code_at,
               max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'login') AS login_at,
               max(coalesce(sent_at, received_at)) FILTER (WHERE edugate_kind = 'rejected') AS rejected_at
        FROM messages
        WHERE edugate_kind IN ('code', 'login', 'rejected')
        GROUP BY 1
    )
    UPDATE students s SET
        code_sent_at = x.code_at,
        registered_at = x.login_at,
        rejected_at = x.rejected_at,
        registration_status = CASE
            WHEN x.login_at IS NOT NULL THEN 'REGISTERED'
            WHEN x.code_at IS NOT NULL THEN 'REGISTRATION_PENDING' END
    FROM x
    WHERE lower(s.email) = x.email
`;
