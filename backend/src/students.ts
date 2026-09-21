import { db } from "./db.js";
import { listColleges } from "./colleges.js";

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

export class InvalidHeaderError extends Error {}

const EXPECTED_HEADER = "student name,college,application no,email,password";

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

interface ExistingStudent {
    central_email: string | null;
    college_id: string | null;
    admission_id: string | null;
    name: string | null;
    smtp_password: string;
    deleted_at: string | null;
}

// Header-based bulk CSV import (Step 7/8). Replaces the old ad hoc
// `name,email,password,college,year_enrolled` paste format. Format:
//   Student Name,College,Application No,Email,Password
// - College must be one of the colleges table's exact full names, and must
//   match the operator's currently selected college - a row for a different
//   college is rejected, never silently redirected or imported anyway.
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

    const headerEntry = nonEmpty[0];
    const normalizedHeader = headerEntry
        ? parseCsvLine(headerEntry.line).join(",").toLowerCase()
        : "";

    if (normalizedHeader !== EXPECTED_HEADER) {
        throw new InvalidHeaderError(
            `First line must be the header: Student Name,College,Application No,Email,Password`
        );
    }

    const dataRows = nonEmpty.slice(1);

    const validColleges = await listColleges();
    const validCollegeNames = new Set(validColleges.map((c) => c.name.toLowerCase()));

    let imported = 0;
    let skipped = 0;
    const rejected: RejectedRow[] = [];

    const seenEmails = new Map<string, number>();
    const seenAdmissionIds = new Map<string, number>();

    for (const { line, number } of dataRows) {
        const fields = parseCsvLine(line);
        const [nameRaw, collegeRaw, admissionIdRaw, emailRaw, passwordRaw] = fields;

        const name = nameRaw?.trim();
        const collegeText = collegeRaw?.trim();
        const admissionId = admissionIdRaw?.trim();
        const email = emailRaw?.trim().toLowerCase();
        const password = passwordRaw?.trim();

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

        if (!password) {
            rejected.push({ line: number, email, reason: "Missing password" });
            continue;
        }

        if (!collegeText || !validCollegeNames.has(collegeText.toLowerCase())) {
            rejected.push({
                line: number,
                email,
                reason: "College must be an exact full college name (no abbreviations)",
            });
            continue;
        }

        if (collegeText.toLowerCase() !== collegeName.toLowerCase()) {
            rejected.push({
                line: number,
                email,
                reason: `Row belongs to ${collegeText}, but you are importing into ${collegeName}`,
            });
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
                INSERT INTO students (name, first_name, last_name, email, smtp_password, central_email, college, college_id, admission_id, is_test)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
                `,
                [name, first, last, email, password, centralEmail, collegeName, collegeId, admissionId]
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
