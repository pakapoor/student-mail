import { db } from "./db.js";
import { countEffectivelyPendingByEmail } from "./thread.js";

// Admin roster: scoped to the logged-in operator's own central mailbox AND
// selected college, same as students.ts's fetchStudents. Only used for the
// admin roster page; messages/threads stay scoped the same way elsewhere.

export interface AdminStudentRow {
    id: number;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    email: string;
    admission_id: string | null;
    year_enrolled: number | null;
    created_at: string;
    deleted_at: string | null;
    // Edugate registration status (migration 010, registrationStatus.ts).
    registration_status: "REGISTRATION_PENDING" | "REGISTERED" | null;
    code_sent_at: string | null;
    registered_at: string | null;
    // Newest document-rejection email, and the roster filter bucket.
    rejected_at: string | null;
    edugate_state: RosterFilter | null;
}

// Roster filter buttons (Step 23), named like the console's thread filters.
// Each student is in at most one bucket: their latest Edugate event decides,
// the same rule as the console's thread badge. A rejected student is still
// registered (the account exists) but shows under Rejected - staff must act.
export type RosterFilter = "code_live" | "code_expired" | "registered" | "rejected";
export const ROSTER_FILTERS: RosterFilter[] = ["code_live", "code_expired", "registered", "rejected"];
export type RosterCounts = Record<RosterFilter | "all", number>;

export interface AdminStudentPage {
    students: AdminStudentRow[];
    nextCursor: string | null;
    // First page only: per-bucket counts for the current search.
    counts?: RosterCounts;
}

// Edugate's code emails say "valid for 30 minutes" (same fallback as the
// console, frontend MessageList.tsx).
const CODE_VALID_MINUTES = 30;

const EDUGATE_STATE_SQL = `
    CASE
        WHEN r.rejected_at IS NOT NULL
             AND r.rejected_at >= coalesce(st.code_sent_at, '-infinity')
             AND r.rejected_at >= coalesce(st.registered_at, '-infinity')
            THEN 'rejected'
        WHEN st.code_sent_at IS NOT NULL
             AND (st.registered_at IS NULL OR st.code_sent_at > st.registered_at)
            THEN CASE WHEN st.code_sent_at > now() - make_interval(mins => ${CODE_VALID_MINUTES})
                      THEN 'code_live' ELSE 'code_expired' END
        WHEN st.registered_at IS NOT NULL THEN 'registered'
    END`;

// Students matching the base conditions, with their bucket attached.
function rosterCte(conditions: string[]): string {
    return `
        WITH roster AS (
            SELECT st.id, st.first_name, st.last_name, st.name, st.email, st.admission_id,
                   st.year_enrolled, st.created_at, st.deleted_at, st.registration_status,
                   st.code_sent_at, st.registered_at, r.rejected_at,
                   ${EDUGATE_STATE_SQL} AS edugate_state
            FROM students st
            LEFT JOIN LATERAL (
                SELECT max(coalesce(m.sent_at, m.received_at)) AS rejected_at
                FROM messages m
                WHERE lower(m.student_email) = lower(st.email) AND m.edugate_kind = 'rejected'
            ) r ON true
            WHERE ${conditions.join(" AND ")}
        )`;
}

const PAGE_SIZE = 30;

interface Cursor {
    first: string;
    last: string;
    id: number;
}

// Keyset (not offset) pagination on (first_name, last_name, id), matching the
// ORDER BY below - stable and cheap at 1600+ rows, unlike OFFSET which gets
// slower and can skip/duplicate rows as the underlying data changes.
function encodeCursor(row: AdminStudentRow): string {
    const raw = `${row.first_name ?? ""}\u0000${row.last_name ?? ""}\u0000${row.id}`;
    return Buffer.from(raw, "utf8").toString("base64");
}

function decodeCursor(cursor: string): Cursor | null {
    try {
        const raw = Buffer.from(cursor, "base64").toString("utf8");
        const [first, last, idText] = raw.split("\u0000");
        const id = Number(idText);

        if (!Number.isInteger(id)) {
            return null;
        }

        return { first: first ?? "", last: last ?? "", id };
    } catch {
        return null;
    }
}

export async function searchAdminStudents(opts: {
    centralEmail: string;
    collegeId: string;
    search?: string;
    cursor?: string | null;
    deleted?: boolean;
    // One roster filter button, or null for All.
    status?: RosterFilter | null;
    limit?: number;
}): Promise<AdminStudentPage> {
    const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 100);
    const deleted = Boolean(opts.deleted);
    const search = opts.search?.trim() || "";

    // Scope + search: shared by the page and the counts, so the counts
    // always describe the current search.
    const base: string[] = [
        deleted ? "st.deleted_at IS NOT NULL" : "st.deleted_at IS NULL",
        "st.central_email = $1",
        "st.college_id = $2",
    ];
    const params: unknown[] = [opts.centralEmail, opts.collegeId];

    if (search) {
        params.push(`%${search}%`);
        base.push(`
            (coalesce(st.first_name,'') || ' ' || coalesce(st.last_name,'') || ' ' ||
             coalesce(st.email,'') || ' ' || coalesce(st.central_email,'') || ' ' ||
             coalesce(st.college,'') || ' ' || coalesce(st.year_enrolled::text,'') || ' ' ||
             coalesce(st.admission_id,'')) ILIKE $${params.length}
        `);
    }

    const baseParams = [...params];
    const pageConditions: string[] = ["true"];

    if (opts.status) {
        params.push(opts.status);
        pageConditions.push(`edugate_state = $${params.length}`);
    }

    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

    if (cursor) {
        params.push(cursor.first, cursor.last, cursor.id);
        const i = params.length;
        pageConditions.push(`
            (coalesce(first_name,''), coalesce(last_name,''), id) > ($${i - 2}, $${i - 1}, $${i})
        `);
    }

    params.push(limit + 1);

    const result = await db.query<AdminStudentRow>(
        `
        ${rosterCte(base)}
        SELECT * FROM roster
        WHERE ${pageConditions.join(" AND ")}
        ORDER BY coalesce(first_name,''), coalesce(last_name,''), id
        LIMIT $${params.length}
        `,
        params
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    const nextCursor = hasMore && lastRow ? encodeCursor(lastRow) : null;

    if (opts.cursor) {
        return { students: page, nextCursor };
    }

    const countResult = await db.query<Record<RosterFilter | "all", string>>(
        `
        ${rosterCte(base)}
        SELECT count(*) AS "all",
               ${ROSTER_FILTERS.map((f) => `count(*) FILTER (WHERE edugate_state = '${f}') AS ${f}`).join(",\n               ")}
        FROM roster
        `,
        baseParams
    );
    const c = countResult.rows[0];
    const counts = Object.fromEntries(
        (["all", ...ROSTER_FILTERS] as const).map((k) => [k, Number(c?.[k] ?? 0)])
    ) as RosterCounts;

    return { students: page, nextCursor, counts };
}

export async function pendingCountsForStudents(
    ids: number[],
    centralEmail: string,
    collegeId: string
): Promise<Record<number, number>> {
    if (ids.length === 0) {
        return {};
    }

    // Uses the same timing-based "effectively pending" definition as the
    // console's own Pending/Replied tabs (thread.ts's
    // countEffectivelyPendingByEmail) rather than a raw replied=false count,
    // so this delete-confirmation warning never disagrees with what the
    // console itself shows for that student.
    const result = await db.query<{ id: number; email: string }>(
        "SELECT id, email FROM students WHERE id = ANY($1) AND central_email = $2 AND college_id = $3",
        [ids, centralEmail, collegeId]
    );

    const emails = result.rows.map((row) => row.email);
    const countsByEmail = await countEffectivelyPendingByEmail(emails);

    const counts: Record<number, number> = {};

    for (const row of result.rows) {
        counts[row.id] = countsByEmail[row.email] || 0;
    }

    return counts;
}

export async function softDeleteStudents(
    ids: number[],
    centralEmail: string,
    collegeId: string
): Promise<number> {
    if (ids.length === 0) {
        return 0;
    }

    if (ids.length > 5) {
        throw new Error("Cannot delete more than 5 students at a time");
    }

    const result = await db.query(
        `
        UPDATE students
        SET deleted_at = NOW()
        WHERE id = ANY($1) AND deleted_at IS NULL
          AND central_email = $2 AND college_id = $3
        `,
        [ids, centralEmail, collegeId]
    );

    return result.rowCount ?? 0;
}

export async function restoreStudent(
    id: number,
    centralEmail: string,
    collegeId: string
): Promise<boolean> {
    const result = await db.query(
        `
        UPDATE students
        SET deleted_at = NULL
        WHERE id = $1 AND deleted_at IS NOT NULL
          AND central_email = $2 AND college_id = $3
        `,
        [id, centralEmail, collegeId]
    );

    return (result.rowCount ?? 0) > 0;
}
