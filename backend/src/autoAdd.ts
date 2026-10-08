import { db } from "./db.js";
import { emailBase, emailCandidates } from "./studentEmail.js";
import { migaduMailboxApi, MailboxApiError, type MailboxApi } from "./migadu.js";
import { recordMigaduCall } from "./migaduTiming.js";
import { splitName } from "./students.js";

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
    // The line exactly as it was pasted (trimmed), so a failed line can be put
    // back in the box for the clerk to fix.
    source: string;
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

// Audit trail: one line in the server log per event, tagged [audit] so it can be
// found with `journalctl -u student-mail | grep '\[audit\]'`. Staff share one
// login, so who did it is the central mailbox, the college and the client's
// IP address. Never contains a password.
function audit(event: string, details: Record<string, unknown>): void {
    console.log(`[audit] ${JSON.stringify({ at: new Date().toISOString(), event, ...details })}`);
}

// The users are clerks: a line is exactly "name,Application No" with one comma
// between them (spaces around the comma, before the name or after the number are
// fine; Windows, Unix or old Mac line endings all work). A space or a tab instead of
// the comma is flagged, never guessed at - a wrong guess would create a
// real mailbox for the wrong name.
const EXPECTED_HEADER = "student name,application no";

// One line split at its commas, each part trimmed. No quote handling: a line
// has exactly one comma. Same as the box (frontend/src/studentLines.ts).
function splitFields(line: string): string[] {
    return line.split(",").map((field) => field.trim());
}
// A name is words made only of letters (A-Z, a-z) separated by spaces - first,
// middle and last names alike; every real student on file already looks like this.
// Same rule as the box (frontend/src/studentLines.ts).
const NAME_PATTERN = /^[A-Za-z]+( [A-Za-z]+)*$/;
const NAME_MESSAGE = "The name can only have letters (A to Z) and spaces - no numbers, dots, hyphens or other symbols";
const COMMA_RULE = "Put a comma between the name and the Application No, like Jane Doe,10012345";
const DEFAULT_PASSWORD = "password";
// Each line is a few calls to Migadu (measured ~0.8 s per line, one after
// another on purpose - Migadu publishes no rate limits); this keeps one request
// well under the proxy's 60 s timeout even if Migadu is several times slower.
export const AUTO_ADD_MAX_ROWS = 10;
// How many addresses are tried per name (x.y, x.y1 ... x.y49).
const MAX_CANDIDATES = 50;
// A mailbox that already exists at the wanted address, has exactly this student's
// name, was created this many minutes ago or less, and is not in our students
// table is taken to be this same add's own earlier try (the create reached Migadu
// but the answer was lost) and is used instead of making a second one.
const ADOPT_WITHIN_MINUTES = 10;

// What staff see when something fails. The technical detail goes to the server
// log, never to the screen.
const MAILBOX_FAILURE = "The mailbox could not be created right now. Try again; if it keeps failing, tell the owner.";
const GENERIC_FAILURE = "Something went wrong adding this student. Try again; if it keeps failing, tell the owner.";

export async function autoAddStudents(
    csvText: string,
    centralEmail: string,
    collegeId: string,
    collegeName: string,
    mailboxes: MailboxApi = migaduMailboxApi(recordMigaduCall),
    clientIp = ""
): Promise<AutoAddResult> {
    const who = { central: centralEmail, college: collegeName, ip: clientIp };
    const nonEmpty = csvText
        .split(/\r\n|\n|\r/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.trim().length > 0);

    const first = nonEmpty[0];
    const hasHeader = first ? splitFields(first.line).join(",").toLowerCase() === EXPECTED_HEADER : false;
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
        const fields = splitFields(line);
        const name = (fields[0] ?? "").replace(/\s+/g, " ").trim();
        const admissionId = (fields[1] ?? "").trim();
        const row: AutoAddRow = { line: number, name, admissionId, source: line.trim(), email: null, status: "failed", reason: null };
        rows.push(row);

        if (fields.length < 2) {
            row.reason = COMMA_RULE;
            continue;
        }

        if (fields.length > 2) {
            row.reason = "Use only one comma, between the name and the Application No";
            continue;
        }

        if (!name) {
            row.reason = "Missing student name";
            continue;
        }

        if (!NAME_PATTERN.test(name)) {
            row.reason = NAME_MESSAGE;
            continue;
        }

        if (!admissionId) {
            row.reason = "Missing Application No";
            continue;
        }

        // An Application No is a whole positive number (every existing one is):
        // digits only, not all zeros. Anything else is a typo or a misplaced
        // word - never create a mailbox from it.
        if (!/^\d+$/.test(admissionId) || !/[1-9]/.test(admissionId)) {
            row.reason = `Application No must be a whole number, digits only (got "${admissionId}")`;
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

            const created = await createMailbox(base, name, mailboxes, usedEmails);

            if (!created) {
                row.reason = `No free address found for ${base} (tried ${MAX_CANDIDATES})`;
                continue;
            }

            const { localPart, migaduOnly, adopted } = created;
            // The mailbox now exists in Migadu - the part that cannot be undone from the console.
            audit(adopted ? "mailbox-adopted" : "mailbox-created", { ...who, line: number, email: `${localPart}@${mailboxes.domain}`, applicationNo: admissionId, name });

            const email = `${localPart}@${mailboxes.domain}`;
            row.email = email;
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
                // An adopted mailbox is left alone: it was made by an earlier try whose
                // outcome we could not see, so removing it here would be a guess.
                if (!adopted) {
                    await mailboxes.remove(localPart).catch((removeError) => {
                        console.error("Auto-add: could not remove the mailbox after a failed save", { email }, removeError);
                    });
                    audit("mailbox-removed", { ...who, line: number, email, reason: "saving the student failed" });
                }

                usedEmails.delete(localPart);
                row.email = null;
                row.reason = "The mailbox was created but the student could not be saved, so the mailbox was removed. Try this line again.";
                continue;
            }

            row.status = "added";
            // An address that is in Migadu but not in our student list was made by
            // hand earlier - it may even be this student's own mailbox, so say so.
            row.reason = adopted
                ? "A mailbox for this student had just been created by an earlier try, so it was used (no second mailbox was made)."
                : localPart === base
                    ? null
                    : migaduOnly.length > 0
                      ? `${migaduOnly[0]} already exists in Migadu but is not in our student list, so a number was added after the name. If that is this student's own mailbox, tell the owner.`
                      : `${base} was taken, so a number was added after the name`;
        } catch (error) {
            console.error("Auto-add failed for a line", { line: number }, error);
            row.email = null;
            row.reason = error instanceof MailboxApiError ? MAILBOX_FAILURE : GENERIC_FAILURE;
        }
    }

    for (const row of rows) {
        audit("student-add", {
            ...who,
            line: row.line,
            outcome: row.status,
            name: row.name,
            applicationNo: row.admissionId,
            email: row.status === "added" ? row.email : null,
            reason: row.reason,
        });
    }

    return {
        added: rows.filter((r) => r.status === "added").length,
        skipped: rows.filter((r) => r.status === "skipped").length,
        failed: rows.filter((r) => r.status === "failed").length,
        rows,
    };
}

// Creates the mailbox on the first of base, base1, base2 ... that is free in this
// import, in our students table and in Migadu, and returns its local part plus
// the addresses skipped because they exist in Migadu only (made by hand earlier,
// not in our students table); null when none of the candidates works.
// One create per line, no retry here: the console retries a failed line ONCE
// after all lines have been tried, as a new request, and that request looks the
// addresses up again - so an address that was taken in the meantime (Migadu
// answers it with a plain 400 "bad request") simply gets the next number.
async function createMailbox(
    base: string,
    name: string,
    mailboxes: MailboxApi,
    usedInThisImport: Set<string>
): Promise<{ localPart: string; migaduOnly: string[]; adopted: boolean } | null> {
    const migaduOnly: string[] = [];

    for (const candidate of emailCandidates(base, MAX_CANDIDATES)) {
        if (usedInThisImport.has(candidate)) {
            continue;
        }

        const inDb = await db.query("SELECT 1 FROM students WHERE email = $1", [`${candidate}@${mailboxes.domain}`]);

        if ((inDb.rowCount ?? 0) > 0) {
            continue;
        }

        if (await mailboxes.exists(candidate)) {
            // Taken in Migadu and not in our table. If it carries exactly this student's
            // name and was made a few minutes ago, it is this add's own earlier try
            // (the create reached Migadu, the answer was lost): use it.
            const info = await mailboxes.inspect(candidate);

            if (
                info &&
                info.name.trim().toLowerCase() === name.toLowerCase() &&
                info.createdMinutesAgo !== null &&
                info.createdMinutesAgo <= ADOPT_WITHIN_MINUTES
            ) {
                return { localPart: candidate, migaduOnly, adopted: true };
            }

            migaduOnly.push(candidate);
            continue;
        }

        await mailboxes.create(candidate, name, DEFAULT_PASSWORD);
        return { localPart: candidate, migaduOnly, adopted: false };
    }

    return null;
}
