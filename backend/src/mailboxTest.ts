import { randomInt } from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import type { ParsedMail } from "mailparser";
import { db } from "./db.js";
import { audit } from "./addLog.js";
import type { MailboxApi } from "./migadu.js";

// Step 48: a student added through Add students only counts as added once its new
// mailbox has really received mail.
//
// 1. Inside the add request (autoAdd.ts -> sendFirstTestMail): the new mailbox is
//    checked (Migadu lookup + IMAP login) and a TEST email is sent to it from the
//    central mailbox. The student is already saved, but with mailbox_confirmed_at
//    NULL, so no staff screen shows them yet.
// 2. The browser then asks POST /api/students/test-mailbox (testNewMailbox) until
//    the answer is no longer "waiting": the new mailbox is watched (read-only IMAP)
//    for the mail. Arrived: mailbox_confirmed_at is set, the student appears.
// 3. Not arrived LIMIT_SECONDS after the student was saved: the add has failed.
//    The student's Application No is changed to a random unused number (so the
//    real one can be added again), the record is marked deleted (hidden for good,
//    a late mail changes nothing) and one detailed "add-failed" entry goes to the
//    Add students log on the status page. The Migadu mailbox is kept.
//
// The TEST email carries TEST_HEADER and comes from the central mailbox itself, so
// the console never stores it (sync.ts); when the central sync sees it, it confirms
// the student too (confirmFromTestMail), in case the browser has stopped asking.

export const TEST_HEADER = "x-student-mail-test";
export const TEST_SUBJECT = "TEST - mailbox check, please ignore";
const TEST_TEXT =
    "TEST - an automatic check that this new mailbox receives email, sent when the student was added. Please ignore.";
// Measured 2026-10-15 on 13 real mailboxes: create -> mail in the inbox 5-14 s.
export const LIMIT_SECONDS = 60;
// One look per request at most this long (the browser gives up after 45 s).
export const WAIT_MS = 20000;
const POLL_MS = 1000;
// The new mailbox's IMAP login is retried each second for at most this long.
const LOGIN_TRY_MS = 15000;
// The request is only accepted for a student saved this recently.
const NEW_STUDENT_MINUTES = 60;
export const FAILED_MESSAGE = "This student's email could not be created. Please try again after 10 minutes.";

export interface MailboxLogin {
    email: string;
    password: string;
}

export interface MailboxTestTransport {
    // Logs in to the mailbox and out again; throws when the login is refused.
    login(mailbox: MailboxLogin): Promise<void>;
    send(from: MailboxLogin, to: string, messageId: string): Promise<void>;
    // Looks in the mailbox's INBOX for the message for up to waitMs (one look when 0).
    // `seconds` is from the mail's Date header to its arrival, null when unknown.
    waitFor(mailbox: MailboxLogin, messageId: string, waitMs: number): Promise<{ found: boolean; seconds: number | null }>;
}

export type MailboxTestState = "received" | "waiting" | "failed";

export interface MailboxTestResult {
    state: MailboxTestState;
    seconds?: number | null;
}

export interface NewStudent {
    id: string | number;
    email: string;
    password: string;
    name: string;
    admissionId: string;
}

export interface Who {
    central: string;
    college: string;
    ip: string;
}

// Fixed per student, so every look finds the mail sent at the add.
export function testMessageId(studentId: string | number, email: string): string {
    return `<mailbox-test-${studentId}@${email.split("@")[1] ?? "localhost"}>`;
}

// True for the console's own test email: the header, and sent by the central
// mailbox itself (a stranger adding the header cannot hide mail from staff unless
// they also forge the central address).
export function isMailboxTestMail(parsed: Pick<ParsedMail, "headers">, senderEmail: string, centralEmail: string): boolean {
    return parsed.headers?.has(TEST_HEADER) === true && senderEmail.toLowerCase() === centralEmail.toLowerCase();
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Step 1, called by autoAdd.ts right after the student is saved. Never throws: a
// failed check or send is logged ("test-send-failed") and tried again by the next
// testNewMailbox request.
export async function sendFirstTestMail(
    student: NewStudent,
    who: Who,
    mailboxes: Pick<MailboxApi, "exists" | "domain">,
    transport: MailboxTestTransport = realTransport
): Promise<boolean> {
    const about = { ...who, name: student.name, applicationNo: student.admissionId, email: student.email };
    const messageId = testMessageId(student.id, student.email);
    const check: Record<string, unknown> = {};

    try {
        let start = Date.now();
        check.lookupFound = await mailboxes.exists(student.email.split("@")[0]!);
        check.lookupMs = Date.now() - start;

        start = Date.now();
        let tries = 0;

        for (;;) {
            tries++;

            try {
                await transport.login({ email: student.email, password: student.password });
                break;
            } catch (error) {
                if (Date.now() - start >= LOGIN_TRY_MS) {
                    check.loginTries = tries;
                    check.loginMs = Date.now() - start;
                    throw new Error(`login to the new mailbox refused: ${errorText(error)}`);
                }

                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
        }

        check.loginTries = tries;
        check.loginMs = Date.now() - start;

        start = Date.now();
        await sendFromCentral(who.central, student.email, messageId, transport);
        await audit("test-sent", { ...about, messageId, ...check, sendMs: Date.now() - start });
        return true;
    } catch (error) {
        console.error("Mailbox test: first send failed", { email: student.email }, errorText(error));
        await audit("test-send-failed", { ...about, messageId, ...check, reason: errorText(error) });
        return false;
    }
}

async function sendFromCentral(centralEmail: string, to: string, messageId: string, transport: MailboxTestTransport): Promise<void> {
    const central = await db.query<{ password: string }>("SELECT password FROM central_mailboxes WHERE email = $1", [centralEmail]);
    const centralPassword = central.rows[0]?.password;

    if (!centralPassword) {
        throw new Error(`no password stored for the central mailbox ${centralEmail}`);
    }

    await transport.send({ email: centralEmail, password: centralPassword }, to, messageId);
}

// Steps 2 and 3, one browser request. null = no such student (not this college or
// mailbox, or added too long ago).
export async function testNewMailbox(
    email: string,
    who: Who,
    collegeId: string,
    transport: MailboxTestTransport = realTransport,
    waitMs = WAIT_MS
): Promise<MailboxTestResult | null> {
    const found = await db.query<{
        id: string;
        email: string;
        smtp_password: string;
        name: string | null;
        admission_id: string | null;
        created_at: Date;
        confirmed: boolean;
        deleted: boolean;
        age_seconds: number;
    }>(
        `SELECT id, email, smtp_password, name, admission_id, created_at,
                mailbox_confirmed_at IS NOT NULL AS confirmed, deleted_at IS NOT NULL AS deleted,
                EXTRACT(EPOCH FROM (now() - created_at)) AS age_seconds
         FROM students
         WHERE email = $1 AND central_email = $2 AND college_id = $3
           AND created_at > now() - make_interval(mins => $4)`,
        [email.toLowerCase(), who.central, collegeId, NEW_STUDENT_MINUTES]
    );
    const student = found.rows[0];

    if (!student) {
        return null;
    }

    if (student.confirmed && !student.deleted) {
        return { state: "received" };
    }

    if (student.deleted) {
        return { state: "failed" };
    }

    const about = { ...who, name: student.name, applicationNo: student.admission_id, email: student.email };
    const messageId = testMessageId(student.id, student.email);
    const mailbox = { email: student.email, password: student.smtp_password };
    const ageMs = Number(student.age_seconds) * 1000;
    let lastError: string | null = null;

    try {
        if (!(await alreadySent(messageId))) {
            await sendFromCentral(who.central, student.email, messageId, transport);
            await audit("test-sent", { ...about, messageId, retried: true });
        }

        // Never past the limit: the last request ends right at it.
        const result = await transport.waitFor(mailbox, messageId, Math.max(0, Math.min(waitMs, LIMIT_SECONDS * 1000 - ageMs)));

        if (result.found) {
            await markConfirmed(student.id, about, { seconds: result.seconds, via: "add dialog" });
            return { state: "received", seconds: result.seconds };
        }
    } catch (error) {
        // A refused login or a failed send: tried again on the next request.
        lastError = errorText(error);
        console.error("Mailbox test: try failed", { email: student.email }, lastError);
    }

    const ageNow = Date.now() - new Date(student.created_at).getTime();

    if (ageNow < LIMIT_SECONDS * 1000) {
        return { state: "waiting" };
    }

    return failAdd(student, about, messageId, lastError);
}

// The add failed: free the real Application No, hide the record for good, and log
// everything known. If the central sync confirmed the student a moment ago, the
// student is kept and this reports received.
async function failAdd(
    student: { id: string; email: string; admission_id: string | null; created_at: Date },
    about: Record<string, unknown>,
    messageId: string,
    lastError: string | null
): Promise<MailboxTestResult> {
    const connection = await db.connect();
    let newNumber: string | null = null;

    try {
        await connection.query("BEGIN");
        const college = await connection.query<{ college_id: string }>(
            "SELECT college_id FROM students WHERE id = $1 AND mailbox_confirmed_at IS NULL AND deleted_at IS NULL FOR UPDATE",
            [student.id]
        );

        if (college.rowCount === 0) {
            await connection.query("ROLLBACK");
            const now = await db.query<{ confirmed: boolean }>("SELECT mailbox_confirmed_at IS NOT NULL AS confirmed FROM students WHERE id = $1", [student.id]);
            return { state: now.rows[0]?.confirmed ? "received" : "failed" };
        }

        newNumber = await unusedNumber(connection, college.rows[0]!.college_id);
        await connection.query("UPDATE students SET admission_id = $2, deleted_at = now() WHERE id = $1", [student.id, newNumber]);
        await connection.query("COMMIT");
    } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        connection.release();
    }

    const steps = await logEntriesFor(messageId);
    await audit("add-failed", {
        ...about,
        newApplicationNo: newNumber,
        messageId,
        createdAt: new Date(student.created_at).toISOString(),
        waitedSeconds: Math.round((Date.now() - new Date(student.created_at).getTime()) / 1000),
        reason: lastError ? `no test email after ${LIMIT_SECONDS} s; last error: ${lastError}` : `no test email after ${LIMIT_SECONDS} s`,
        steps,
        mailboxKept: student.email,
    });
    return { state: "failed" };
}

// A random 12-digit number starting 99 that no student of the college has.
async function unusedNumber(connection: { query: typeof db.query }, collegeId: string): Promise<string> {
    for (;;) {
        const candidate = `99${String(randomInt(0, 10_000_000_000)).padStart(10, "0")}`;
        const taken = await connection.query("SELECT 1 FROM students WHERE college_id = $1 AND admission_id = $2", [collegeId, candidate]);

        if ((taken.rowCount ?? 0) === 0) {
            return candidate;
        }
    }
}

// The steps logged so far for this test mail (check, send), for the failure entry.
async function logEntriesFor(messageId: string): Promise<unknown[]> {
    try {
        const rows = await db.query<{ at: Date; event: string; details: Record<string, unknown> }>(
            "SELECT at, event, details FROM student_add_log WHERE details->>'messageId' = $1 ORDER BY id",
            [messageId]
        );
        return rows.rows.map((r) => {
            const { central: _c, college: _co, ip: _i, name: _n, applicationNo: _a, email: _e, messageId: _m, ...rest } = r.details;
            return { at: r.at.toISOString(), event: r.event, ...rest };
        });
    } catch {
        return [];
    }
}

// The add dialog may have been closed (or the browser lost) before the limit: once a
// minute, every new student still unconfirmed a little after the limit gets one last
// look at the mailbox and is then failed the same way. Started by server.ts.
const SWEEP_EVERY_MS = 60 * 1000;
const SWEEP_GRACE_SECONDS = 30;

export async function failStaleAdds(transport: MailboxTestTransport = realTransport): Promise<number> {
    const stale = await db.query<{
        id: string;
        email: string;
        smtp_password: string;
        name: string | null;
        admission_id: string | null;
        created_at: Date;
        central_email: string;
        college: string | null;
    }>(
        `SELECT id, email, smtp_password, name, admission_id, created_at, central_email, college
         FROM students
         WHERE mailbox_confirmed_at IS NULL AND deleted_at IS NULL
           AND created_at < now() - make_interval(secs => $1)
           AND created_at > now() - make_interval(mins => $2)`,
        [LIMIT_SECONDS + SWEEP_GRACE_SECONDS, NEW_STUDENT_MINUTES * 24]
    );
    let failed = 0;

    for (const s of stale.rows) {
        const about = { central: s.central_email, college: s.college, ip: "", name: s.name, applicationNo: s.admission_id, email: s.email };
        const messageId = testMessageId(s.id, s.email);
        let lastError: string | null = "the add dialog was closed before the check ended";

        try {
            const result = await transport.waitFor({ email: s.email, password: s.smtp_password }, messageId, 0);

            if (result.found) {
                await markConfirmed(s.id, about, { seconds: result.seconds, via: "server check" });
                continue;
            }
        } catch (error) {
            lastError = `${lastError}; last look failed: ${errorText(error)}`;
        }

        if ((await failAdd(s, about, messageId, lastError)).state === "failed") {
            failed++;
        }
    }

    return failed;
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startStaleAddSweep(): void {
    if (sweepTimer) {
        return;
    }

    sweepTimer = setInterval(() => {
        failStaleAdds().catch((error) => console.error("Mailbox test: stale add check failed", errorText(error)));
    }, SWEEP_EVERY_MS);
    sweepTimer.unref();
}

// If the log cannot be read, it counts as sent: better no mail than one per request.
async function alreadySent(messageId: string): Promise<boolean> {
    try {
        const sent = await db.query(
            "SELECT 1 FROM student_add_log WHERE event = 'test-sent' AND details->>'messageId' = $1 LIMIT 1",
            [messageId]
        );
        return (sent.rowCount ?? 0) > 0;
    } catch {
        return true;
    }
}

async function markConfirmed(studentId: string | number, about: Record<string, unknown>, extra: Record<string, unknown>): Promise<boolean> {
    const updated = await db.query(
        "UPDATE students SET mailbox_confirmed_at = now() WHERE id = $1 AND mailbox_confirmed_at IS NULL AND deleted_at IS NULL",
        [studentId]
    );

    if ((updated.rowCount ?? 0) > 0) {
        await audit("test-received", { ...about, ...extra });
        return true;
    }

    return false;
}

// Called by the sync for a TEST mail it skips: confirms the student it was sent to
// (a mail that arrives after the browser stopped asking, but within the limit).
// A failed (deleted) student stays failed. Never throws.
export async function confirmFromTestMail(studentEmail: string, messageId: string): Promise<void> {
    try {
        const student = await db.query<{ id: string; name: string | null; admission_id: string | null; email: string; college: string | null }>(
            `SELECT id, name, admission_id, email, college FROM students
             WHERE lower(email) = lower($1) AND mailbox_confirmed_at IS NULL AND deleted_at IS NULL`,
            [studentEmail]
        );
        const s = student.rows[0];

        if (!s || testMessageId(s.id, s.email) !== messageId) {
            return;
        }

        await markConfirmed(s.id, { college: s.college, name: s.name, applicationNo: s.admission_id, email: s.email }, { via: "central sync" });
    } catch (error) {
        console.error("Mailbox test: could not confirm from the central copy", { studentEmail }, errorText(error));
    }
}

function imapClient(mailbox: MailboxLogin): ImapFlow {
    const client = new ImapFlow({
        host: process.env.IMAP_HOST!,
        port: Number(process.env.IMAP_PORT || 993),
        secure: true,
        auth: { user: mailbox.email, pass: mailbox.password },
        logger: false,
    });
    // imapflow emits 'error' on socket problems; without a listener that would
    // crash the process instead of just failing this look.
    client.on("error", () => {});
    return client;
}

async function closeClient(client: ImapFlow): Promise<void> {
    if (client.usable) {
        await Promise.race([client.logout().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    client.close();
}

// Never hold a request past the wait plus time to log in.
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const stop = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("mailbox did not respond in time")), ms);
    });

    try {
        return await Promise.race([work, stop]);
    } finally {
        clearTimeout(timer);
    }
}

const realTransport: MailboxTestTransport = {
    async login(mailbox) {
        const client = imapClient(mailbox);

        try {
            await withDeadline(client.connect(), 10000);
        } finally {
            await closeClient(client);
        }
    },

    async send(from, to, messageId) {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 465),
            secure: process.env.SMTP_SECURE !== "false",
            auth: { user: from.email, pass: from.password },
            connectionTimeout: 10000,
            socketTimeout: 10000,
        });

        await transporter.sendMail({
            from: from.email,
            to,
            subject: TEST_SUBJECT,
            text: TEST_TEXT,
            messageId,
            headers: { "X-Student-Mail-Test": "1" },
        });
    },

    async waitFor(mailbox, messageId, waitMs) {
        const client = imapClient(mailbox);

        try {
            return await withDeadline(look(client, messageId, waitMs), waitMs + 15000);
        } finally {
            await closeClient(client);
        }
    },
};

async function look(client: ImapFlow, messageId: string, waitMs: number): Promise<{ found: boolean; seconds: number | null }> {
    const deadline = Date.now() + waitMs;
    const seen = new Set<number>();

    await client.connect();
    // Read-only (IMAP EXAMINE): nothing in the student's mailbox is changed.
    await client.mailboxOpen("INBOX", { readOnly: true });

    for (;;) {
        const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        const uids = ((await client.search({ since }, { uid: true })) || []).filter((uid) => !seen.has(uid));

        if (uids.length > 0) {
            for await (const msg of client.fetch(uids, { envelope: true, internalDate: true, uid: true }, { uid: true })) {
                seen.add(msg.uid);

                if (msg.envelope?.messageId === messageId) {
                    const sent = msg.envelope.date ? new Date(msg.envelope.date).getTime() : NaN;
                    const arrived = msg.internalDate ? new Date(msg.internalDate).getTime() : NaN;
                    const seconds = Number.isNaN(sent) || Number.isNaN(arrived) ? null : Math.max(0, Math.round((arrived - sent) / 1000));
                    return { found: true, seconds };
                }
            }
        }

        if (Date.now() + POLL_MS > deadline) {
            return { found: false, seconds: null };
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        // NOOP lets the server tell us about mail that arrived meanwhile.
        await client.noop();
    }
}
