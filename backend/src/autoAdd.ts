import { db } from "./db.js";
import { emailBase, emailCandidates } from "./studentEmail.js";
import { migaduMailboxApi, type MailboxApi } from "./migadu.js";
import { parseCsvLine, splitName } from "./students.js";

// "Add students" with two inputs per line: Student Name,Application No.
// For each line the server works out the email address (studentEmail.ts),
// creates the Migadu mailbox, then saves the student - email, password
// "password", the current year and the operator's college are all set here.
// A line is only saved after its mailbox exists, and a mailbox is removed
// again if saving fails, so nothing is left half done. Lines are handled one
// after another (no two lines can pick the same address).

export type AutoAddStatus = "added" | "skipped" | "failed";

export interface AutoAddRow {
    line: number;
    name: string;
    admissionId: string;
    email: string | null;
    status: AutoAddStatus;
    // Why a line was skipped or failed; a note on an added line (e.g. a number
    // was added because the address was taken); null otherwise.
    reason: string | null;
}

export interface AutoAddResult {
    added: number;
    skipped: number;
    failed: number;
    rows: AutoAddRow[];
}

export class AutoAddInputError extends Error {}

const EXPECTED_HEADER = "student name,application no";
const DEFAULT_PASSWORD = "password";
// Each line is a few calls to Migadu (measured ~0.8 s per line, one after
// another on purpose - Migadu publishes no rate limits); this keeps one request
// well under the proxy's 60 s timeout even if Migadu is several times slower.
export const AUTO_ADD_MAX_ROWS = 10;
// How many addresses are tried per name (x.y, x.y1 ... x.y49).
const MAX_CANDIDATES = 50;

export async function autoAddStudents(
    csvText: string,
    centralEmail: string,
    collegeId: string,
    collegeName: string,
    mailboxes: MailboxApi = migaduMailboxApi()
): Promise<AutoAddResult> {
    const nonEmpty = csvText
        .split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.trim().length > 0);

    const first = nonEmpty[0];
    const hasHeader = first ? parseCsvLine(first.line).join(",").toLowerCase() === EXPECTED_HEADER : false;
    const dataRows = hasHeader ? nonEmpty.slice(1) : nonEmpty;

    if (dataRows.length === 0) {
        throw new AutoAddInputError("Paste at least one line: Student Name,Application No");
    }

    if (dataRows.length > AUTO_ADD_MAX_ROWS) {
        throw new AutoAddInputError(`Add at most ${AUTO_ADD_MAX_ROWS} students at a time (you pasted ${dataRows.length})`);
    }

    const year = new Date().getUTCFullYear();
    const rows: AutoAddRow[] = [];
    const seenAdmissionIds = new Map<string, number>();
    const usedEmails = new Set<string>();

    for (const { line, number } of dataRows) {
        const [nameRaw, admissionRaw] = parseCsvLine(line);
        const name = (nameRaw ?? "").replace(/\s+/g, " ").trim();
        const admissionId = (admissionRaw ?? "").trim();
        const row: AutoAddRow = { line: number, name, admissionId, email: null, status: "failed", reason: null };
        rows.push(row);

        if (!name) {
            row.reason = "Missing student name";
            continue;
        }

        if (!admissionId) {
            row.reason = "Missing Application No";
            continue;
        }

        const base = emailBase(name);

        if (!base) {
            row.reason = "The name has no letters to make an email address from";
            continue;
        }

        const earlierLine = seenAdmissionIds.get(admissionId);

        if (earlierLine !== undefined) {
            row.status = "skipped";
            row.reason = `Application No ${admissionId} is also on line ${earlierLine}. No mailbox was created.`;
            continue;
        }

        seenAdmissionIds.set(admissionId, number);

        try {
            const used = await db.query<{ name: string | null }>(
                "SELECT name FROM students WHERE college_id = $1 AND admission_id = $2",
                [collegeId, admissionId]
            );

            if ((used.rowCount ?? 0) > 0) {
                row.status = "skipped";
                row.reason = `Application No ${admissionId} is already used by ${used.rows[0]?.name ?? "another student"}. No mailbox was created.`;
                continue;
            }

            const localPart = await freeLocalPart(base, mailboxes, usedEmails);

            if (!localPart) {
                row.reason = `No free address found for ${base} (tried ${MAX_CANDIDATES})`;
                continue;
            }

            const email = `${localPart}@${mailboxes.domain}`;
            row.email = email;

            await mailboxes.create(localPart, name, DEFAULT_PASSWORD);
            usedEmails.add(localPart);

            try {
                const { first: firstName, last: lastName } = splitName(name);
                await db.query(
                    `
                    INSERT INTO students (name, first_name, last_name, email, smtp_password, central_email, college, college_id, admission_id, year_enrolled, is_test)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE)
                    `,
                    [name, firstName, lastName, email, DEFAULT_PASSWORD, centralEmail, collegeName, collegeId, admissionId, year]
                );
            } catch (error) {
                console.error("Auto-add: saving the student failed", { line: number, email }, error);
                await mailboxes.remove(localPart).catch((removeError) => {
                    console.error("Auto-add: could not remove the mailbox after a failed save", { email }, removeError);
                });
                usedEmails.delete(localPart);
                row.email = null;
                row.reason = "The mailbox was created but the student could not be saved, so the mailbox was removed. Try this line again.";
                continue;
            }

            row.status = "added";
            row.reason = localPart === base ? null : `${base} was taken, so a number was added after the name`;
        } catch (error) {
            console.error("Auto-add failed for a line", { line: number }, error);
            row.email = null;
            row.reason = error instanceof Error ? error.message : "Unexpected error";
        }
    }

    return {
        added: rows.filter((r) => r.status === "added").length,
        skipped: rows.filter((r) => r.status === "skipped").length,
        failed: rows.filter((r) => r.status === "failed").length,
        rows,
    };
}

// First of base, base1, base2 ... that is free in this import, in our
// students table and in Migadu. null when none of the candidates is free.
async function freeLocalPart(base: string, mailboxes: MailboxApi, usedInThisImport: Set<string>): Promise<string | null> {
    for (const candidate of emailCandidates(base, MAX_CANDIDATES)) {
        if (usedInThisImport.has(candidate)) {
            continue;
        }

        const inDb = await db.query("SELECT 1 FROM students WHERE email = $1", [`${candidate}@${mailboxes.domain}`]);

        if ((inDb.rowCount ?? 0) > 0) {
            continue;
        }

        if (await mailboxes.exists(candidate)) {
            continue;
        }

        return candidate;
    }

    return null;
}
