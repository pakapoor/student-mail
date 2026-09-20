import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "./db.js";

export interface SyncResult {
    inserted: number;
    skipped: number;
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

    await client.connect();

    const lock = await client.getMailboxLock("INBOX");

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

        const mailboxExists =
            client.mailbox &&
            typeof client.mailbox === "object" &&
            "exists" in client.mailbox
                ? Number(client.mailbox.exists)
                : 0;

        if (mailboxExists === 0) {
            return { inserted, skipped };
        }

        const start = Math.max(1, mailboxExists - 49);

        for await (const message of client.fetch(`${start}:*`, {
            source: true,
            internalDate: true,
        })) {
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

            const studentEmail = toAddresses.find((address) =>
                students.has(address)
            );

            if (!studentEmail) {
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
                ON CONFLICT (message_id)
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
                console.log(
                    "NEW:",
                    studentEmail,
                    "|",
                    senderEmail,
                    "|",
                    parsed.subject || "(no subject)"
                );
            } else {
                skipped++;
            }
        }
    } finally {
        lock.release();
        await client.logout();
    }

    return { inserted, skipped };
}
