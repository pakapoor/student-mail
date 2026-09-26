import crypto from "node:crypto";
import { ImapFlow } from "imapflow";
import type { College } from "./colleges.js";
import { db } from "./db.js";

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

// Sessions live in Postgres (migration 011) so a backend restart doesn't
// log everyone out. Only a SHA-256 of the cookie token is stored. A small
// in-memory cache saves a query per request; after a restart it refills
// from the table on first use.
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

interface Session {
    email: string;
    college: College | null;
}

const cache = new Map<string, Session & { expiresAt: number }>();

function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(email: string): Promise<string> {
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;

    // Housekeeping on login is plenty at this scale.
    await db.query("DELETE FROM sessions WHERE expires_at < NOW()");
    await db.query(
        "INSERT INTO sessions (token_hash, email, expires_at) VALUES ($1, $2, $3)",
        [hashToken(token), email, new Date(expiresAt)]
    );
    cache.set(token, { email, college: null, expiresAt });
    return token;
}

export async function setSessionCollege(token: string, college: College): Promise<boolean> {
    const result = await db.query(
        "UPDATE sessions SET college_id = $2 WHERE token_hash = $1 AND expires_at > NOW()",
        [hashToken(token), college.id]
    );

    if ((result.rowCount ?? 0) === 0) {
        cache.delete(token);
        return false;
    }

    const cached = cache.get(token);
    if (cached) {
        cached.college = college;
    }

    return true;
}

export async function getSession(token: string | undefined): Promise<Session | undefined> {
    if (!token) {
        return undefined;
    }

    const cached = cache.get(token);
    if (cached) {
        if (cached.expiresAt > Date.now()) {
            return cached;
        }

        cache.delete(token);
        return undefined;
    }

    const result = await db.query<{ email: string; expires_at: Date; college_id: string | null; college_name: string | null }>(
        `SELECT s.email, s.expires_at, c.id AS college_id, c.name AS college_name
         FROM sessions s LEFT JOIN colleges c ON c.id = s.college_id
         WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
        [hashToken(token)]
    );
    const row = result.rows[0];

    if (!row) {
        return undefined;
    }

    const session = {
        email: row.email,
        college: row.college_id ? { id: String(row.college_id), name: row.college_name ?? "" } : null,
        expiresAt: new Date(row.expires_at).getTime(),
    };
    cache.set(token, session);
    return session;
}

export async function destroySession(token: string | undefined): Promise<void> {
    if (token) {
        cache.delete(token);
        await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    }
}
