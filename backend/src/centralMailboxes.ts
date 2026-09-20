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
    const result = await db.query<CentralMailbox>(
        "SELECT email, password FROM central_mailboxes"
    );

    return result.rows;
}
