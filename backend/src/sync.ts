import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { db } from "./db.js";
import { logMigaduDelay, measureMigaduHold, type MigaduHold } from "./migaduDelay.js";
import { classifyEdugate, isEdugateSender } from "../../shared/edugate.js";
import { applyRegistrationEvent } from "./registrationStatus.js";

// Shared by the central-mailbox sync below and the per-student direct check
// (checkStudentMail.ts). Both paths key on (message_id, student_email), so a
// message that arrives through both - forwarded to central AND fetched
// straight from the student's own mailbox - is only ever stored once;
// whichever path gets there first wins and the other is a no-op.
// Returns true if a new row was inserted.
export async function insertMessageForStudent(
    parsed: ParsedMail,
    messageId: string,
    senderEmail: string,
    studentEmail: string,
    receivedAt: Date | string,
    centralEmail: string,
    migaduHold: MigaduHold | null = null
): Promise<boolean> {
    // The sender's own send time (Date: header) - ordering uses this rather
    // than arrival, which Migadu delays can scramble.
    const sentAt = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null;
    const edugateKind = classifyEdugate(senderEmail, parsed.text, studentEmail)?.kind ?? null;

    const referenceIds = Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
        ? [parsed.references]
        : [];

    const result = await db.query(
        `
        INSERT INTO messages (
            message_id,
            student_email,
            sender_email,
            subject,
            received_at,
            body_text,
            body_html,
            in_reply_to,
            reference_ids,
            central_email,
            migadu_hold_seconds,
            migadu_queue_id,
            sent_at,
            edugate_kind
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (message_id, student_email)
        DO NOTHING
        RETURNING id
        `,
        [
            messageId,
            studentEmail,
            senderEmail,
            parsed.subject || "",
            receivedAt,
            parsed.text,
            parsed.html || null,
            parsed.inReplyTo,
            referenceIds,
            centralEmail,
            migaduHold ? Math.round(migaduHold.holdMs / 1000) : null,
            migaduHold?.queueId ?? null,
            sentAt,
            edugateKind,
        ]
    );

    const inserted = result.rowCount === 1;

    if (inserted) {
        // An Edugate email that matches none of the verified templates:
        // Edugate may have changed its wording or added a new type (e.g. a
        // password reset). Nothing breaks - no box, no status change - but
        // it's logged so the template can be checked and added.
        if (isEdugateSender(senderEmail) && !edugateKind) {
            console.warn(
                `[edugate] UNKNOWN LAYOUT from=${senderEmail} student=${studentEmail} ` +
                    `subject="${parsed.subject || "(no subject)"}" message=${messageId}`
            );
        }

        if (edugateKind === "code" || edugateKind === "login") {
            try {
                await applyRegistrationEvent(studentEmail, edugateKind, sentAt ?? receivedAt);
            } catch (error) {
                // The email is stored either way; only the status is stale.
                console.error(`[edugate] status update failed student=${studentEmail}:`, error);
            }
        }
    }

    return inserted;
}

// Migadu sometimes returns a just-arrived email without its content (seen
// ~40 times in 4 days). The sync used to skip it AND move last_uid past it,
// so it was never tried again - e.g. mahek.khan's registration email
// (24 Sep, UID 429) was missing from the console for 2 days. Now the
// watermark stops just before such an email so the next pass retries it;
// after MAX_SOURCE_ATTEMPTS failures in a row it's given up (logged) so one
// broken email can never block everything after it.
const MAX_SOURCE_ATTEMPTS = 5;
const missingSourceAttempts = new Map<string, number>();

export interface SyncResult {
    inserted: number;
    // An email came back without content and will be retried - the caller
    // schedules a quick follow-up pass instead of waiting for new mail.
    retryPending?: boolean;
    // Which students got new mail this pass - lets the live update tell
    // each console whether the mail is for its college (new-mail chime).
    insertedStudentEmails: string[];
    skipped: number;
}

interface MailboxState {
    last_uid: string | null;
    uid_validity: string | null;
}

export async function syncInbox(
    centralEmail: string,
    centralPassword: string
): Promise<SyncResult> {
    const client = new ImapFlow({
        host: process.env.IMAP_HOST!,
        port: Number(process.env.IMAP_PORT || 993),
        secure: true,
        auth: {
            user: centralEmail,
            pass: centralPassword,
        },
        logger: false,
    });

    const syncStart = Date.now();
    await client.connect();

    const lock = await client.getMailboxLock("INBOX", { acquireTimeout: 30000 });

    let inserted = 0;
    let retryPending = false;
    const insertedStudents = new Set<string>();
    let skipped = 0;

    try {
        const studentResult = await db.query(
            "SELECT email FROM students WHERE central_email = $1",
            [centralEmail]
        );

        const students = new Set(
            studentResult.rows.map((row) => row.email.toLowerCase())
        );

        const mailbox = client.mailbox;

        if (!mailbox || typeof mailbox !== "object") {
            return { inserted, skipped, insertedStudentEmails: [...insertedStudents] };
        }

        const currentUidValidity = mailbox.uidValidity;
        const mailboxExists = mailbox.exists;

        if (mailboxExists === 0) {
            await db.query(
                `UPDATE central_mailboxes SET last_uid = 0, uid_validity = $2 WHERE email = $1`,
                [centralEmail, currentUidValidity.toString()]
            );
            return { inserted, skipped, insertedStudentEmails: [...insertedStudents] };
        }

        const stateResult = await db.query<MailboxState>(
            "SELECT last_uid, uid_validity FROM central_mailboxes WHERE email = $1",
            [centralEmail]
        );
        const state = stateResult.rows[0];
        const storedUidValidity = state?.uid_validity != null ? BigInt(state.uid_validity) : null;
        const storedLastUid = state?.last_uid != null ? Number(state.last_uid) : null;

        const isFirstSync = storedUidValidity === null;
        const uidValidityChanged = !isFirstSync && storedUidValidity !== currentUidValidity;

        let fetchRange: string;
        let useUidMode: boolean;

        if (isFirstSync || uidValidityChanged) {
            // Bounded catch-up baseline (same window as the old always-last-50
            // behavior). UIDVALIDITY changing is a rare server-side UID reset -
            // any previously stored UID watermark is meaningless afterward.
            if (uidValidityChanged) {
                console.warn(
                    `[sync] UIDVALIDITY changed for [${centralEmail}] (was ${storedUidValidity}, now ${currentUidValidity}) - resetting UID tracking, doing bounded catch-up`
                );
            }

            const start = Math.max(1, mailboxExists - 49);
            fetchRange = `${start}:*`;
            useUidMode = false;
        } else {
            // Incremental: fetch everything since the last processed UID, no
            // matter how many messages that is - no 50-message ceiling.
            fetchRange = `${storedLastUid! + 1}:*`;
            useUidMode = true;
        }

        let maxUidSeen = storedLastUid ?? 0;
        // Lowest UID that came back without content this pass (retry it).
        let retryFromUid: number | null = null;

        for await (const message of client.fetch(
            fetchRange,
            { source: true, internalDate: true, uid: true },
            { uid: useUidMode }
        )) {
            if (message.uid > maxUidSeen) {
                maxUidSeen = message.uid;
            }

            const attemptKey = `${centralEmail}:${currentUidValidity}:${message.uid}`;

            if (!message.source) {
                const attempts = (missingSourceAttempts.get(attemptKey) ?? 0) + 1;

                if (attempts < MAX_SOURCE_ATTEMPTS) {
                    missingSourceAttempts.set(attemptKey, attempts);
                    retryFromUid = retryFromUid === null ? message.uid : Math.min(retryFromUid, message.uid);
                    console.warn(
                        `[sync] [${centralEmail}] UID ${message.uid}: no message source returned by IMAP fetch ` +
                            `(attempt ${attempts}/${MAX_SOURCE_ATTEMPTS}), will retry`
                    );
                } else {
                    missingSourceAttempts.delete(attemptKey);
                    console.error(
                        `[sync] [${centralEmail}] GIVING UP uid=${message.uid} after ${MAX_SOURCE_ATTEMPTS} tries - ` +
                            `no message source; searching the student in the console (mailbox check) can still recover it`
                    );
                }

                continue;
            }

            missingSourceAttempts.delete(attemptKey);

            const parsed = await simpleParser(message.source);

            const messageId = parsed.messageId;

            if (!messageId) {
                console.warn(`[sync] [${centralEmail}] UID ${message.uid}: no Message-ID header, skipping (subject: "${parsed.subject || "(no subject)"}")`);
                continue;
            }

            const toObjects = parsed.to
                ? Array.isArray(parsed.to)
                    ? parsed.to
                    : [parsed.to]
                : [];

            const toAddresses: string[] = toObjects.flatMap((to) =>
                to.value
                    .map((address) => address.address?.toLowerCase())
                    .filter((address): address is string => Boolean(address))
            );

            // A single external message can be addressed to several of our
            // students at once (e.g. one government notice to a cohort) -
            // each student's mailbox forwards its own copy here independently,
            // so every matching student gets its own tracked row, not just
            // the first match.
            const matchingStudents = toAddresses.filter((address) =>
                students.has(address)
            );

            if (matchingStudents.length === 0) {
                console.warn(
                    `[sync] [${centralEmail}] UID ${message.uid} "${messageId}": To address(es) [${toAddresses.join(", ") || "none"}] matched no registered student, skipping (subject: "${parsed.subject || "(no subject)"}")`
                );
                continue;
            }

            const senderEmail = parsed.from?.value[0]?.address?.toLowerCase();

            if (!senderEmail) {
                console.warn(`[sync] [${centralEmail}] UID ${message.uid} "${messageId}": no parseable From address, skipping`);
                continue;
            }

            // How long Migadu held the email before it reached the mailbox:
            // stored on the row, and logged (below) if it's an incident.
            const hold = measureMigaduHold(message.source);
            let insertedThisMessage = false;

            for (const studentEmail of matchingStudents) {
                const wasInserted = await insertMessageForStudent(
                    parsed,
                    messageId,
                    senderEmail,
                    studentEmail,
                    message.internalDate || new Date(),
                    centralEmail,
                    hold
                );

                if (wasInserted) {
                    inserted++;
                    insertedThisMessage = true;
                    insertedStudents.add(studentEmail);
                    const insertedAt = Date.now();
                    const arrivedDate = message.internalDate ? new Date(message.internalDate) : null;
                    const arrivalToInsertMs = arrivedDate ? insertedAt - arrivedDate.getTime() : null;
                    console.log(
                        "NEW:",
                        studentEmail,
                        "|",
                        senderEmail,
                        "|",
                        parsed.subject || "(no subject)"
                    );
                    console.log(
                        `[TIMING] arrival-to-DB-insert for "${messageId}" [${studentEmail}]: ${arrivalToInsertMs ?? "unknown"}ms` +
                            ` (arrived ${arrivedDate?.toISOString() ?? "unknown"}, inserted ${new Date(insertedAt).toISOString()})`
                    );
                } else {
                    skipped++;
                }
            }

            // Only for emails stored on this pass - a retry pass re-reads a
            // few already-stored emails and mustn't log them twice.
            if (insertedThisMessage) {
                logMigaduDelay(hold, {
                    mailbox: centralEmail,
                    messageId,
                    senderEmail,
                    students: matchingStudents,
                });
            }
        }

        // Never move the watermark past an email we still want to retry.
        const newLastUid = retryFromUid !== null ? Math.min(maxUidSeen, retryFromUid - 1) : maxUidSeen;
        retryPending = retryFromUid !== null;

        await db.query(
            `UPDATE central_mailboxes SET last_uid = $2, uid_validity = $3 WHERE email = $1`,
            [centralEmail, newLastUid, currentUidValidity.toString()]
        );
    } finally {
        lock.release();
        await client.logout();
    }

    console.log(`[TIMING] syncInbox [${centralEmail}] total duration: ${Date.now() - syncStart}ms (inserted=${inserted}, skipped=${skipped})`);

    return { inserted, skipped, insertedStudentEmails: [...insertedStudents], retryPending };
}
