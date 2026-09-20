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
    centralEmail: string
): Promise<StudentRow[]> {
    const result = await db.query<StudentRow>(
        `
        SELECT id, name, email, created_at
        FROM students
        WHERE central_email = $1
        ORDER BY created_at DESC
        `,
        [centralEmail]
    );

    return result.rows;
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
    centralEmail: string
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
        const [name, emailRaw, password] = fields;
        const email = emailRaw?.toLowerCase();

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

        const existing = await db.query<{ central_email: string | null }>(
            "SELECT central_email FROM students WHERE email = $1",
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

        const result = await db.query(
            `
            INSERT INTO students (name, email, smtp_password, central_email)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (email) DO UPDATE SET
                name = EXCLUDED.name,
                smtp_password = EXCLUDED.smtp_password,
                central_email = EXCLUDED.central_email
            RETURNING (xmax = 0) AS inserted
            `,
            [name || null, email, password, centralEmail]
        );

        if (result.rows[0]?.inserted) {
            imported++;
        } else {
            updated++;
        }
    }

    return { imported, updated, rejected };
}
