import { db } from "./db.js";

// Admin roster (Students dialog): read-only, scoped to the logged-in
// operator's own central mailbox and showing every college, with an optional
// college filter (Step 30). Staff share one login and may already pick any
// college, so this crosses no permission boundary. Messages/threads in the
// console stay college-scoped. There is no delete or restore any more;
// removing a student is done by hand.

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
    college_id: string | null;
    college_name: string | null;
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

// Students per college for the current search, keyed by college id, plus
// "all" (every student matching the search, whatever the college).
export type CollegeCounts = Record<string, number>;

export interface AdminStudentPage {
    students: AdminStudentRow[];
    nextCursor: string | null;
    // First page only: per-bucket counts for the current search and college.
    counts?: RosterCounts;
    // First page only: per-college counts for the current search (not
    // narrowed by the pressed college button or status button).
    collegeCounts?: CollegeCounts;
}

// Edugate's code emails say "valid for 30 minutes" (same fallback as the
// console, frontend MessageList.tsx).
const CODE_VALID_MINUTES = 30;

const EDUGATE_STATE_SQL = `
    CASE
        WHEN st.rejected_at IS NOT NULL
             AND st.rejected_at >= coalesce(st.code_sent_at, '-infinity')
             AND st.rejected_at >= coalesce(st.registered_at, '-infinity')
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
                   st.code_sent_at, st.registered_at, st.rejected_at,
                   st.college_id, c.name AS college_name,
                   ${EDUGATE_STATE_SQL} AS edugate_state
            FROM students st
            LEFT JOIN colleges c ON c.id = st.college_id
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
    // One college button, or null/undefined for all colleges.
    collegeId?: string | null;
    search?: string;
    cursor?: string | null;
    // One roster filter button, or null for All.
    status?: RosterFilter | null;
    limit?: number;
}): Promise<AdminStudentPage> {
    const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 100);
    const search = opts.search?.trim() || "";

    // Mailbox + search: shared by the page, the status counts and the
    // college counts, so all of them describe the current search. The year
    // is deliberately not searchable (every student has the same one).
    const searchConds: string[] = ["st.deleted_at IS NULL", "st.central_email = $1"];
    const searchParams: unknown[] = [opts.centralEmail];

    if (search) {
        searchParams.push(`%${search}%`);
        searchConds.push(`
            (coalesce(st.first_name,'') || ' ' || coalesce(st.last_name,'') || ' ' ||
             coalesce(st.email,'') || ' ' || coalesce(st.central_email,'') || ' ' ||
             coalesce(st.college,'') || ' ' || coalesce(st.admission_id,'')) ILIKE $${searchParams.length}
        `);
    }

    // The pressed college button narrows the page and the status counts,
    // but not the college counts (they show every college for the search).
    const base = [...searchConds];
    const params: unknown[] = [...searchParams];

    if (opts.collegeId) {
        params.push(opts.collegeId);
        base.push(`st.college_id = $${params.length}`);
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

    const collegeResult = await db.query<{ college_id: string | null; n: string }>(
        `
        SELECT st.college_id, count(*) AS n
        FROM students st
        WHERE ${searchConds.join(" AND ")}
        GROUP BY st.college_id
        `,
        searchParams
    );
    const collegeCounts: CollegeCounts = {};
    let total = 0;

    for (const row of collegeResult.rows) {
        const n = Number(row.n);
        total += n;

        if (row.college_id !== null) {
            collegeCounts[String(row.college_id)] = n;
        }
    }

    collegeCounts.all = total;

    return { students: page, nextCursor, counts, collegeCounts };
}
