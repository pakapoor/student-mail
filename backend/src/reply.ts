import nodemailer from "nodemailer";
import { db } from "./db.js";

export interface MessageRow {
    id: number;
    message_id: string;
    student_email: string;
    sender_email: string;
    subject: string | null;
    reference_ids: string[];
    replied?: boolean;
    received_at?: string;
    replied_at?: string | null;
    body_text?: string | null;
    body_html?: string | null;
    central_email: string;
}

export interface ReplyAttachment {
    filename: string;
    path: string;
}

export class AlreadyRepliedError extends Error {
    constructor(messageId: number) {
        super(`Message ${messageId} was already replied to or handled`);
        this.name = "AlreadyRepliedError";
    }
}

export class StudentDeletedError extends Error {
    constructor(studentEmail: string) {
        super(`Student ${studentEmail} has been deleted and can't be replied to`);
        this.name = "StudentDeletedError";
    }
}

// Soft-deleted students' messages stay recorded in the DB (mail still arrives
// even after we retire the roster entry) but must be invisible everywhere in
// the console until restored - so every message-reading query excludes them.
// A message is only visible if its student is active and belongs to the
// selected college - soft-deleted students' messages stay in the DB but must
// be invisible everywhere in the console until restored.
const VISIBLE_TO_COLLEGE = (collegeParamIndex: number) => `
    EXISTS (
        SELECT 1 FROM students s
        WHERE s.email = messages.student_email
          AND s.deleted_at IS NULL
          AND s.college_id = $${collegeParamIndex}
    )
`;

export async function fetchMessageById(
    id: number,
    centralEmail: string,
    collegeId: string
): Promise<MessageRow | undefined> {
    const result = await db.query(
        `
        SELECT id, message_id, student_email, sender_email, subject, reference_ids, replied,
               received_at, replied_at, body_text, body_html, central_email
        FROM messages
        WHERE id = $1 AND central_email = $2 AND ${VISIBLE_TO_COLLEGE(3)}
        `,
        [id, centralEmail, collegeId]
    );

    return result.rows[0];
}

export async function fetchMessages(
    status: "pending" | "replied" | "all",
    centralEmail: string,
    collegeId: string
): Promise<MessageRow[]> {
    if (status === "all") {
        const result = await db.query(
            `
            SELECT id, message_id, student_email, sender_email, subject,
                   received_at, replied, replied_at, central_email
            FROM messages
            WHERE central_email = $1 AND ${VISIBLE_TO_COLLEGE(2)}
            ORDER BY received_at DESC
            `,
            [centralEmail, collegeId]
        );
        return result.rows;
    }

    const result = await db.query(
        `
        SELECT id, message_id, student_email, sender_email, subject,
               received_at, replied, replied_at, central_email
        FROM messages
        WHERE replied = $1 AND central_email = $2 AND ${VISIBLE_TO_COLLEGE(3)}
        ORDER BY received_at ASC
        `,
        [status === "replied", centralEmail, collegeId]
    );

    return result.rows;
}

export async function fetchStudent(email: string) {
    const result = await db.query(
        "SELECT email, smtp_password, deleted_at FROM students WHERE email = $1",
        [email]
    );

    return result.rows[0];
}

export async function sendReply(
    message: MessageRow,
    bodyText: string,
    attachments: ReplyAttachment[] = []
) {
    // Atomically claim this message before doing any slow work (SMTP is
    // network I/O and must not happen inside a DB transaction). If two
    // operators click Send around the same time, only one UPDATE can win
    // this WHERE replied = FALSE race - the loser is rejected immediately,
    // before ever touching SMTP, so we never send a duplicate email.
    const claim = await db.query(
        `
        UPDATE messages
        SET replied = TRUE, replied_at = NOW()
        WHERE id = $1 AND replied = FALSE
        `,
        [message.id]
    );

    if ((claim.rowCount ?? 0) === 0) {
        throw new AlreadyRepliedError(message.id);
    }

    try {
        const student = await fetchStudent(message.student_email);

        if (!student) {
            throw new Error(
                `No student record found for ${message.student_email}`
            );
        }

        if (student.deleted_at) {
            throw new StudentDeletedError(message.student_email);
        }

        const subject =
            message.subject && /^re:/i.test(message.subject)
                ? message.subject
                : `Re: ${message.subject ?? ""}`;

        const references = [
            ...(message.reference_ids || []),
            message.message_id,
        ];

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 465),
            secure: process.env.SMTP_SECURE !== "false",
            auth: {
                user: student.email,
                pass: student.smtp_password,
            },
        });

        const info = await transporter.sendMail({
            from: student.email,
            to: message.sender_email,
            bcc: message.central_email,
            subject,
            text: bodyText,
            inReplyTo: message.message_id,
            references,
            attachments,
        });

        await db.query(
            `
            INSERT INTO replies (
                incoming_message_id,
                student_email,
                recipient_email,
                sent_message_id,
                attachment_count,
                body_text
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [
                message.message_id,
                student.email,
                message.sender_email,
                info.messageId,
                attachments.length,
                bodyText,
            ]
        );

        return info;
    } catch (error) {
        // SMTP (or student lookup) failed - release the claim so the
        // message goes back to Pending, per the "replied must remain
        // false on failure" rule.
        await db.query(
            `
            UPDATE messages
            SET replied = FALSE, replied_at = NULL
            WHERE id = $1
            `,
            [message.id]
        );

        throw error;
    }
}

export async function markHandled(
    messageId: number,
    centralEmail: string,
    collegeId: string
): Promise<boolean> {
    const result = await db.query(
        `
        UPDATE messages
        SET replied = TRUE, replied_at = NOW(), handled_without_reply = TRUE
        WHERE id = $1 AND replied = FALSE AND central_email = $2 AND ${VISIBLE_TO_COLLEGE(3)}
        `,
        [messageId, centralEmail, collegeId]
    );

    return (result.rowCount ?? 0) > 0;
}
