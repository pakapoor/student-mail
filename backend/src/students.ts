import { db } from "./db.js";

export interface StudentRow {
    id: number;
    name: string | null;
    email: string;
    created_at: string;
}

export interface RejectedRow {
    line: number;
    email: string;
    reason: string;
    owner?: string;
}

export interface ImportResult {
    imported: number;
    updated: number;
    rejected: RejectedRow[];
}

export async function fetchStudents(
    centralEmail: string,
    collegeId: string
): Promise<StudentRow[]> {
    const result = await db.query<StudentRow>(
        `
        SELECT id, name, email, created_at
        FROM students
        WHERE central_email = $1 AND college_id = $2
        ORDER BY created_at DESC
        `,
        [centralEmail, collegeId]
    );

    return result.rows;
}

function splitName(name: string | null): { first: string | null; last: string | null } {
    if (!name) {
        return { first: null, last: null };
    }

    const trimmed = name.trim();

    if (!trimmed) {
        return { first: null, last: null };
    }

    const spaceIndex = trimmed.indexOf(" ");

    if (spaceIndex === -1) {
        return { first: trimmed, last: null };
    }

    // Everything after the first space (including any middle name) becomes
    // the last name - there's no separate middle-name field.
    return {
        first: trimmed.slice(0, spaceIndex),
        last: trimmed.slice(spaceIndex + 1).trim() || null,
    };
}

function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (inQuotes) {
            if (char === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
            } else if (char === '"') {
                inQuotes = false;
            } else {
                current += char;
            }
        } else if (char === '"') {
            inQuotes = true;
        } else if (char === ",") {
            fields.push(current);
            current = "";
        } else {
            current += char;
        }
    }

    fields.push(current);
    return fields.map((f) => f.trim());
}

export async function importStudents(
    csvText: string,
    centralEmail: string,
    collegeId: string
): Promise<ImportResult> {
    const lines = csvText
        .split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.trim().length > 0);

    let imported = 0;
    let updated = 0;
    const rejected: RejectedRow[] = [];

    for (const { line, number } of lines) {
        const fields = parseCsvLine(line);
        const [name, emailRaw, password, collegeRaw, yearRaw] = fields;
        const email = emailRaw?.toLowerCase();
        const college = collegeRaw?.trim() || null;
        const yearEnrolled =
            yearRaw && /^\d{4}$/.test(yearRaw.trim()) ? Number(yearRaw.trim()) : null;

        if (!email || !email.includes("@")) {
            rejected.push({
                line: number,
                email: emailRaw || "(missing)",
                reason: "Invalid or missing email",
            });
            continue;
        }

        if (!password) {
            rejected.push({
                line: number,
                email,
                reason: "Missing password",
            });
            continue;
        }

        const existing = await db.query<{
            central_email: string | null;
            college_id: string | null;
        }>(
            "SELECT central_email, college_id FROM students WHERE email = $1",
            [email]
        );

        const existingOwner = existing.rows[0]?.central_email;

        if (existingOwner && existingOwner !== centralEmail) {
            rejected.push({
                line: number,
                email,
                reason: "Already assigned to another central mailbox",
                owner: existingOwner,
            });
            continue;
        }

        const existingCollegeId = existing.rows[0]?.college_id;

        if (existingCollegeId && existingCollegeId !== collegeId) {
            rejected.push({
                line: number,
                email,
                reason: "Already assigned to another college",
            });
            continue;
        }

        const { first, last } = splitName(name || null);

        const result = await db.query(
            `
            INSERT INTO students (name, first_name, last_name, email, smtp_password, central_email, college, college_id, year_enrolled)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (email) DO UPDATE SET
                name = EXCLUDED.name,
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name,
                smtp_password = EXCLUDED.smtp_password,
                central_email = EXCLUDED.central_email,
                college = EXCLUDED.college,
                college_id = EXCLUDED.college_id,
                year_enrolled = EXCLUDED.year_enrolled,
                deleted_at = NULL
            RETURNING (xmax = 0) AS inserted
            `,
            [name || null, first, last, email, password, centralEmail, college, collegeId, yearEnrolled]
        );

        if (result.rows[0]?.inserted) {
            imported++;
        } else {
            updated++;
        }
    }

    return { imported, updated, rejected };
}
