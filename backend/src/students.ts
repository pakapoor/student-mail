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
}

export interface ImportResult {
    imported: number;
    skipped: number;
    rejected: RejectedRow[];
}

const EXPECTED_HEADERS = [
    "student name,application no,email,password",
    "student name,application no,email,password,year",
];
const DEFAULT_PASSWORD = "password";
// A pasted Year may differ from the current year by at most this much.
const YEAR_RANGE = 2;

// The optional 5th import column. Blank/missing = the current (UTC) year;
// otherwise a 4-digit year within YEAR_RANGE of it, or a reason to reject
// the row (never silently replaced by the default).
export function parseImportYear(
    raw: string | undefined,
    currentYear: number
): { year: number } | { error: string } {
    const text = raw?.trim() ?? "";

    if (!text) {
        return { year: currentYear };
    }

    const year = /^\d{4}$/.test(text) ? Number(text) : NaN;

    if (!Number.isInteger(year) || Math.abs(year - currentYear) > YEAR_RANGE) {
        return {
            error: `Year "${text}" must be a 4-digit year within ${YEAR_RANGE} years of ${currentYear}`,
        };
    }

    return { year };
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

export function splitName(name: string | null): { first: string | null; last: string | null } {
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

export function parseCsvLine(line: string): string[] {
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

interface ExistingStudent {
    central_email: string | null;
    college_id: string | null;
    admission_id: string | null;
    name: string | null;
    smtp_password: string;
    deleted_at: string | null;
}

// Bulk CSV import (Step 7/8). Replaces the old ad hoc
// `name,email,password,college,year_enrolled` paste format. Format:
//   Student Name,Application No,Email,Password[,Year]
// Year (Step 30) is optional: blank or missing = the current year; a
// non-blank Year must be 4 digits within 2 years of it. It is set only when
// a student is first inserted, never changed by a re-import.
// An optional header line matching either form exactly (case-insensitive)
// is skipped if present; otherwise every line is treated as data - positional
// parsing doesn't need a header to map columns.
// The importing operator's currently selected college (from the session)
// is used directly - there's no College column, since the server already
// knows which college the import belongs to.
// - Password is optional per row; a blank password defaults to the literal
//   string "password" (deliberately weak - the user asked for this default
//   explicitly; real rosters should still supply a real password).
// - Never silently overwrites an existing student: identical resubmission is
//   a no-op (skip), any differing field is flagged for manual review.
// - is_test is deliberately never set here - it stays a manual/DB-level flag
//   so real-roster imports are never accidentally marked as test data.
export async function importStudents(
    csvText: string,
    centralEmail: string,
    collegeId: string,
    collegeName: string
): Promise<ImportResult> {
    const rawLines = csvText.split(/\r?\n/);
    const nonEmpty = rawLines
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.trim().length > 0);

    // Header row is optional: if the first line is exactly the expected
    // header, skip it; otherwise treat every line as data (positional
    // parsing doesn't need the header to map columns).
    const headerEntry = nonEmpty[0];
    const normalizedHeader = headerEntry
        ? parseCsvLine(headerEntry.line).join(",").toLowerCase()
        : "";
    const hasHeader = EXPECTED_HEADERS.includes(normalizedHeader);

    const dataRows = hasHeader ? nonEmpty.slice(1) : nonEmpty;

    let imported = 0;
    let skipped = 0;
    const rejected: RejectedRow[] = [];

    const currentYear = new Date().getUTCFullYear();
    const seenEmails = new Map<string, number>();
    const seenAdmissionIds = new Map<string, number>();

    for (const { line, number } of dataRows) {
        const fields = parseCsvLine(line);
        const [nameRaw, admissionIdRaw, emailRaw, passwordRaw, yearRaw] = fields;

        const name = nameRaw?.trim();
        const admissionId = admissionIdRaw?.trim();
        const email = emailRaw?.trim().toLowerCase();
        const password = passwordRaw?.trim() || DEFAULT_PASSWORD;

        if (!name) {
            rejected.push({ line: number, email: email || "(missing)", reason: "Missing student name" });
            continue;
        }

        if (!email || !email.includes("@")) {
            rejected.push({ line: number, email: emailRaw || "(missing)", reason: "Invalid or missing email" });
            continue;
        }

        if (!admissionId) {
            rejected.push({ line: number, email, reason: "Missing Application No" });
            continue;
        }

        const parsedYear = parseImportYear(yearRaw, currentYear);

        if ("error" in parsedYear) {
            rejected.push({ line: number, email, reason: parsedYear.error });
            continue;
        }

        const duplicateEmailLine = seenEmails.get(email);
        if (duplicateEmailLine) {
            rejected.push({
                line: number,
                email,
                reason: `Duplicate email within this import (also on line ${duplicateEmailLine})`,
            });
            continue;
        }

        const duplicateAdmissionLine = seenAdmissionIds.get(admissionId);
        if (duplicateAdmissionLine) {
            rejected.push({
                line: number,
                email,
                reason: `Duplicate Application No within this import (also on line ${duplicateAdmissionLine})`,
            });
            continue;
        }

        seenEmails.set(email, number);
        seenAdmissionIds.set(admissionId, number);

        const existingResult = await db.query<ExistingStudent>(
            "SELECT central_email, college_id, admission_id, name, smtp_password, deleted_at FROM students WHERE email = $1",
            [email]
        );
        const existing = existingResult.rows[0];

        if (existing) {
            if (existing.central_email !== centralEmail) {
                rejected.push({ line: number, email, reason: "Email already assigned to another central mailbox" });
                continue;
            }

            if (existing.college_id !== collegeId) {
                rejected.push({ line: number, email, reason: "Email already assigned to another college" });
                continue;
            }

            const identical =
                existing.name === name &&
                existing.admission_id === admissionId &&
                existing.smtp_password === password;

            if (!identical) {
                rejected.push({
                    line: number,
                    email,
                    reason: "Email already exists with different details (name/Application No/password mismatch) - not overwritten",
                });
                continue;
            }

            if (existing.deleted_at) {
                await db.query("UPDATE students SET deleted_at = NULL WHERE email = $1", [email]);
                imported++;
            } else {
                skipped++;
            }

            continue;
        }

        const conflictResult = await db.query(
            "SELECT 1 FROM students WHERE college_id = $1 AND admission_id = $2",
            [collegeId, admissionId]
        );

        if ((conflictResult.rowCount ?? 0) > 0) {
            rejected.push({
                line: number,
                email,
                reason: "Application No already used by another student in this college",
            });
            continue;
        }

        const { first, last } = splitName(name);

        try {
            await db.query(
                `
                INSERT INTO students (name, first_name, last_name, email, smtp_password, central_email, college, college_id, admission_id, year_enrolled, is_test)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE)
                `,
                [name, first, last, email, password, centralEmail, collegeName, collegeId, admissionId, parsedYear.year]
            );
            imported++;
        } catch (error) {
            rejected.push({
                line: number,
                email,
                reason: "Import conflict while saving this row - not saved",
            });
            console.error("Import insert failed", { line: number, email }, error);
        }
    }

    return { imported, skipped, rejected };
}

// Which of these Application Nos are already used by a student of this college
// (deleted students count too: their number stays taken, as in the add flow).
// Answers the Add students box before anything is created; the add itself
// checks again, so this is advice, never the last word. Returns number -> who.
export interface UsedNumber {
    name: string | null;
    deleted: boolean;
}

export const MAX_NUMBERS_TO_CHECK = 50;

export async function usedApplicationNumbers(collegeId: string, numbers: string[]): Promise<Record<string, UsedNumber>> {
    const wanted = [...new Set(numbers)].slice(0, MAX_NUMBERS_TO_CHECK);

    if (wanted.length === 0) {
        return {};
    }

    const result = await db.query<{ admission_id: string; name: string | null; deleted_at: string | null }>(
        "SELECT admission_id, name, deleted_at FROM students WHERE college_id = $1 AND admission_id = ANY($2)",
        [collegeId, wanted]
    );

    const used: Record<string, UsedNumber> = {};

    for (const row of result.rows) {
        used[row.admission_id] = { name: row.name, deleted: row.deleted_at !== null };
    }

    return used;
}
