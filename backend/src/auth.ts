import crypto from "node:crypto";
import { ImapFlow } from "imapflow";

interface Session {
    email: string;
}

const sessions = new Map<string, Session>();

export const SESSION_COOKIE = "session_token";

export async function verifyImapLogin(
    email: string,
    password: string
): Promise<boolean> {
    const activeEmail = process.env.ACTIVE_CENTRAL_EMAIL?.trim().toLowerCase();
    if (activeEmail && email.toLowerCase() !== activeEmail) {
        return false;
    }

    const client = new ImapFlow({
        host: process.env.IMAP_HOST!,
        port: Number(process.env.IMAP_PORT || 993),
        secure: true,
        auth: { user: email, pass: password },
        logger: false,
    });

    try {
        await client.connect();
        await client.logout();
        return true;
    } catch {
        return false;
    }
}

export function createSession(email: string): string {
    const token = crypto.randomUUID();
    sessions.set(token, { email });
    return token;
}

export function getSession(token: string | undefined): Session | undefined {
    if (!token) {
        return undefined;
    }

    return sessions.get(token);
}

export function destroySession(token: string | undefined) {
    if (token) {
        sessions.delete(token);
    }
}
