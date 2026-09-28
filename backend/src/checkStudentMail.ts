import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "./db.js";
import { insertMessageForStudent } from "./sync.js";
import { noteEvent, noteProblem, solveProblems } from "./systemStatus.js";
import { measureMigaduHold } from "./migaduDelay.js";

// On-demand fallback for "the email hasn't shown up in the console": reads
// ONE student's own INBOX directly (instead of relying on it having been
// forwarded to the central mailbox) and adds whatever the console is missing.
// Triggered automatically when a console search narrows to exactly one
// student, or by the "Check again" button. Never runs as a background sweep -
// with ~2300 students, logging in to every mailbox on a schedule would be far
// too many logins for Migadu.
//
// Merging is free: rows are keyed on (message_id, student_email), so a
// message recovered here and later forwarded to central (or vice versa) is
// only ever stored once.

const LOOKBACK_DAYS = 7;
// An automatic re-check of the same student inside this window returns the
// last result instead of logging in again (e.g. an operator searching the
// same student repeatedly). "Check again" (force) bypasses it.
const COOLDOWN_MS = 2 * 60 * 1000;
// Same ceiling as the central sync's watchdog (mailboxSync.ts).
const CHECK_TIMEOUT_MS = 45000;
// Migadu sometimes refuses correct passwords for a few minutes (2026-09-26:
// 7 mailboxes "Authentication failed" in 4 min, all fine minutes later).
// The daily sweep tries once more after this wait before reporting a
// problem. The hot list doesn't wait (it holds up other waiting students'
// checks and rechecks the same mailbox within minutes anyway), and a console
// search reports at once - the operator can press "Check again".
const AUTH_RETRY_MS = 60 * 1000;

export interface CheckStudent {
    id: number;
    email: string;
    password: string;
}

export type FailureReason = "auth" | "timeout" | "network" | "error";

export type CheckOutcome =
    | { status: "ok"; checked: number; added: number; checkedAt: number }
    | { status: "failed"; reason?: FailureReason };

// Who asked for the check - only changes the log prefix and how chatty it
// is. The console search logs every check; the rolling daily sweep (sweep.ts)
// checks ~2300 mailboxes a day, so it only logs finds and failures.
export type CheckSource = "check-mail" | "sweep" | "hot";

const lastResults = new Map<string, { checked: number; added: number; checkedAt: number }>();
// Two operators (or a double click) checking the same student at once share
// one IMAP session instead of logging in twice.
const inFlight = new Map<string, Promise<CheckOutcome>>();

export function checkStudentMailbox(
    student: CheckStudent,
    centralEmail: string,
    force: boolean,
    source: CheckSource = "check-mail"
): Promise<CheckOutcome> {
    const key = student.email.toLowerCase();

    const running = inFlight.get(key);
    if (running) {
        return running;
    }

    const last = lastResults.get(key);
    if (!force && last && Date.now() - last.checkedAt < COOLDOWN_MS) {
        return Promise.resolve({ status: "ok", ...last });
    }

    const promise = runCheck(student, centralEmail, source).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}

async function runCheck(student: CheckStudent, centralEmail: string, source: CheckSource): Promise<CheckOutcome> {
    const first = await attemptCheck(student, centralEmail, source, source === "sweep");

    if (first.status === "failed" && first.reason === "auth" && source === "sweep") {
        await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_MS));
        return attemptCheck(student, centralEmail, source, false);
    }

    return first;
}

// One login + read. `willRetry`: a refused login is only logged, not
// reported as a problem, because runCheck is about to try again.
async function attemptCheck(
    student: CheckStudent,
    centralEmail: string,
    source: CheckSource,
    willRetry: boolean
): Promise<CheckOutcome> {
    const start = Date.now();
    const client = new ImapFlow({
        host: process.env.IMAP_HOST!,
        port: Number(process.env.IMAP_PORT || 993),
        secure: true,
        auth: { user: student.email, pass: student.password },
        logger: false,
    });
    // imapflow emits 'error' on socket problems; without a listener that
    // would crash the process instead of just failing this one check.
    client.on("error", () => {});

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError()), CHECK_TIMEOUT_MS);
    });

    try {
        const { checked, added } = await Promise.race([
            fetchMissing(client, student, centralEmail, source),
            timeout,
        ]);
        const checkedAt = Date.now();
        lastResults.set(student.email.toLowerCase(), { checked, added, checkedAt });

        if (source === "check-mail" || added > 0) console.log(
            `[${source}] OK student=${student.email} id=${student.id} operator=${centralEmail} ` +
                `checked=${checked} added=${added} (${LOOKBACK_DAYS} days) took=${checkedAt - start}ms`
        );

        solveProblems("mailbox-failed", student.email.toLowerCase());

        return { status: "ok", checked, added, checkedAt };
    } catch (error) {
        const reason = classifyFailure(error);
        const detail = error instanceof Error ? error.message : String(error);
        const serverResponse =
            error && typeof error === "object" && "responseText" in error
                ? ` server said: ${String((error as { responseText: unknown }).responseText)}`
                : "";

        const retrying = willRetry && reason === "auth";

        console.error(
            `[${source}] ${retrying ? "LOGIN REFUSED, retrying in 60s" : "FAILED"} student=${student.email} id=${student.id} ` +
                `operator=${centralEmail} reason=${reason} (${detail}${serverResponse}) took=${Date.now() - start}ms`
        );

        if (!retrying) {
            noteProblem(
                "mailbox-failed",
                student.email.toLowerCase(),
                `${student.email}: ${
                    reason === "auth"
                        ? `Migadu refused the login${source === "sweep" ? " twice, 1 min apart" : ""} (often temporary; if it keeps failing, check the password)`
                        : `${reason} (${detail})`
                }`,
                source
            );
        }

        return { status: "failed", reason };
    } finally {
        clearTimeout(timer);
        // A polite LOGOUT when the connection is healthy, but never let a
        // stuck connection hold the request open - close() always follows.
        if (client.usable) {
            await Promise.race([
                client.logout().catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
        }
        client.close();
    }
}

async function fetchMissing(
    client: ImapFlow,
    student: CheckStudent,
    centralEmail: string,
    source: CheckSource
): Promise<{ checked: number; added: number }> {
    await client.connect();
    // Read-only (IMAP EXAMINE): nothing in the student's mailbox gets marked
    // as read or changed in any way.
    await client.mailboxOpen("INBOX", { readOnly: true });

    // SINCE matches on the server's arrival date, so mail Migadu delivered
    // hours late is still inside the window.
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const uids = (await client.search({ since }, { uid: true })) || [];

    if (uids.length === 0) {
        return { checked: 0, added: 0 };
    }

    // Cheap first pass: just Message-IDs, so full messages are only
    // downloaded for the ones the console doesn't already have.
    const idByUid = new Map<number, string>();
    for await (const msg of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
        if (msg.envelope?.messageId) {
            idByUid.set(msg.uid, msg.envelope.messageId);
        }
    }

    const existing = await db.query<{ message_id: string }>(
        "SELECT message_id FROM messages WHERE student_email = $1 AND message_id = ANY($2)",
        [student.email.toLowerCase(), [...idByUid.values()]]
    );
    const known = new Set(existing.rows.map((r) => r.message_id));
    const missingUids = uids.filter((uid) => !known.has(idByUid.get(uid) ?? ""));

    let added = 0;

    if (missingUids.length > 0) {
        for await (const msg of client.fetch(
            missingUids,
            { source: true, internalDate: true, uid: true },
            { uid: true }
        )) {
            if (!msg.source) {
                console.warn(`[${source}] student=${student.email} UID ${msg.uid}: no message source returned, skipping`);
                continue;
            }

            const parsed = await simpleParser(msg.source);
            const messageId = parsed.messageId;

            if (!messageId) {
                console.warn(
                    `[${source}] student=${student.email} UID ${msg.uid}: no Message-ID header, skipping (subject: "${parsed.subject || "(no subject)"}")`
                );
                continue;
            }

            const senderEmail = parsed.from?.value[0]?.address?.toLowerCase();

            if (!senderEmail) {
                console.warn(`[${source}] student=${student.email} UID ${msg.uid} "${messageId}": no parseable From address, skipping`);
                continue;
            }

            // The mailbox owner is the student - no To-header matching
            // needed, which is exactly what rescues BCC'd / mailing-list mail
            // the central sync can't attribute to anyone.
            const wasInserted = await insertMessageForStudent(
                parsed,
                messageId,
                senderEmail,
                student.email.toLowerCase(),
                msg.internalDate || new Date(),
                centralEmail,
                // The student's own copy - Migadu holds each recipient's
                // copy separately, so this is the hold for this mailbox.
                measureMigaduHold(msg.source)
            );

            if (wasInserted) {
                added++;
                console.log(
                    `[${source}] RECOVERED student=${student.email} "${messageId}" from=${senderEmail} ` +
                        `arrived=${msg.internalDate ? new Date(msg.internalDate).toISOString() : "unknown"} ` +
                        `subject="${parsed.subject || "(no subject)"}"`
                );
                noteEvent("recovered", `${student.email}: ${parsed.subject || "(no subject)"} from ${senderEmail}`, source);
            }
        }
    }

    return { checked: uids.length, added };
}

class CheckTimeoutError extends Error {
    constructor() {
        super(`mailbox did not respond within ${CHECK_TIMEOUT_MS}ms`);
    }
}

function classifyFailure(error: unknown): FailureReason {
    if (error instanceof CheckTimeoutError) {
        return "timeout";
    }

    const e = error as { authenticationFailed?: boolean; code?: string } | null;

    if (e?.authenticationFailed) {
        return "auth";
    }

    if (
        e?.code &&
        ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(e.code)
    ) {
        return "network";
    }

    return "error";
}
