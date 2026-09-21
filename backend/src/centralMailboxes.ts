import { db } from "./db.js";

export interface CentralMailbox {
    email: string;
    password: string;
}

export async function registerCentralMailbox(
    email: string,
    password: string
): Promise<void> {
    await db.query(
        `
        INSERT INTO central_mailboxes (email, password)
        VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password
        `,
        [email, password]
    );
}

export async function listCentralMailboxes(): Promise<CentralMailbox[]> {
    const activeEmail = process.env.ACTIVE_CENTRAL_EMAIL?.trim().toLowerCase();
    const result = await db.query<CentralMailbox>(
        `SELECT email, password FROM central_mailboxes
         WHERE ($1::text IS NULL OR LOWER(email) = $1)`,
        [activeEmail || null]
    );

    return result.rows;
}
