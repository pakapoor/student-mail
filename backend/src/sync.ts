import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "./db.js";

export interface SyncResult {
    inserted: number;
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
            return { inserted, skipped };
        }

        const currentUidValidity = mailbox.uidValidity;
        const mailboxExists = mailbox.exists;

        if (mailboxExists === 0) {
            await db.query(
                `UPDATE central_mailboxes SET last_uid = 0, uid_validity = $2 WHERE email = $1`,
                [centralEmail, currentUidValidity.toString()]
            );
            return { inserted, skipped };
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

        for await (const message of client.fetch(
            fetchRange,
            { source: true, internalDate: true, uid: true },
            { uid: useUidMode }
        )) {
            if (message.uid > maxUidSeen) {
                maxUidSeen = message.uid;
            }

            if (!message.source) {
                continue;
            }

            const parsed = await simpleParser(message.source);

            const messageId = parsed.messageId;

            if (!messageId) {
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
                continue;
            }

            const senderEmail = parsed.from?.value[0]?.address?.toLowerCase();

            if (!senderEmail) {
                continue;
            }

            const referenceIds = Array.isArray(parsed.references)
                ? parsed.references
                : parsed.references
                ? [parsed.references]
                : [];

            for (const studentEmail of matchingStudents) {
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
                        central_email
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (message_id, student_email)
                    DO NOTHING
                    RETURNING id
                    `,
                    [
                        messageId,
                        studentEmail,
                        senderEmail,
                        parsed.subject || "",
                        message.internalDate || new Date(),
                        parsed.text,
                        parsed.html || null,
                        parsed.inReplyTo,
                        referenceIds,
                        centralEmail,
                    ]
                );

                if (result.rowCount === 1) {
                    inserted++;
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
        }

        await db.query(
            `UPDATE central_mailboxes SET last_uid = $2, uid_validity = $3 WHERE email = $1`,
            [centralEmail, maxUidSeen, currentUidValidity.toString()]
        );
    } finally {
        lock.release();
        await client.logout();
    }

    console.log(`[TIMING] syncInbox [${centralEmail}] total duration: ${Date.now() - syncStart}ms (inserted=${inserted}, skipped=${skipped})`);

    return { inserted, skipped };
}
