import { db } from "./db.js";

// Cross-operator student directory: unlike students.ts's fetchStudents (scoped
// to the logged-in operator's own central mailbox), this deliberately shows
// students across ALL central mailboxes - there is no admin role, so any
// logged-in operator can browse/search/delete the full roster. Only used for
// the admin roster page; messages/threads stay scoped per-operator elsewhere.

export interface AdminStudentRow {
    id: number;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    email: string;
    college: string | null;
    year_enrolled: number | null;
    central_email: string | null;
    created_at: string;
    deleted_at: string | null;
}

export interface AdminStudentPage {
    students: AdminStudentRow[];
    nextCursor: string | null;
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
    search?: string;
    cursor?: string | null;
    deleted?: boolean;
    limit?: number;
}): Promise<AdminStudentPage> {
    const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 100);
    const deleted = Boolean(opts.deleted);
    const search = opts.search?.trim() || "";

    const conditions: string[] = [
        deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL",
    ];
    const params: unknown[] = [];

    if (search) {
        params.push(`%${search}%`);
        conditions.push(`
            (coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' ||
             coalesce(email,'') || ' ' || coalesce(central_email,'') || ' ' ||
             coalesce(college,'') || ' ' || coalesce(year_enrolled::text,'')) ILIKE $${params.length}
        `);
    }

    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

    if (cursor) {
        params.push(cursor.first, cursor.last, cursor.id);
        const i = params.length;
        conditions.push(`
            (coalesce(first_name,''), coalesce(last_name,''), id) > ($${i - 2}, $${i - 1}, $${i})
        `);
    }

    params.push(limit + 1);

    const result = await db.query<AdminStudentRow>(
        `
        SELECT id, first_name, last_name, name, email, college, year_enrolled, central_email, created_at, deleted_at
        FROM students
        WHERE ${conditions.join(" AND ")}
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

    return { students: page, nextCursor };
}

export async function pendingCountsForStudents(
    ids: number[]
): Promise<Record<number, number>> {
    if (ids.length === 0) {
        return {};
    }

    const result = await db.query<{ id: number; pending_count: string }>(
        `
        SELECT s.id, COUNT(m.id) FILTER (WHERE m.replied = FALSE) AS pending_count
        FROM students s
        LEFT JOIN messages m ON m.student_email = s.email
        WHERE s.id = ANY($1)
        GROUP BY s.id
        `,
        [ids]
    );

    const counts: Record<number, number> = {};

    for (const row of result.rows) {
        counts[row.id] = Number(row.pending_count);
    }

    return counts;
}

export async function softDeleteStudents(ids: number[]): Promise<number> {
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
        `,
        [ids]
    );

    return result.rowCount ?? 0;
}

export async function restoreStudent(id: number): Promise<boolean> {
    const result = await db.query(
        `
        UPDATE students
        SET deleted_at = NULL
        WHERE id = $1 AND deleted_at IS NOT NULL
        `,
        [id]
    );

    return (result.rowCount ?? 0) > 0;
}
