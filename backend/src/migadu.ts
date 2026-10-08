// Migadu mailbox API (https://api.migadu.com/v1). Basic auth: the admin account
// email plus an API key (My Account > API Keys; the login password does not
// work). Used only to create a student's mailbox when staff add students.

export interface MailboxApi {
    domain: string;
    exists(localPart: string): Promise<boolean>;
    create(localPart: string, name: string, password: string): Promise<void>;
    remove(localPart: string): Promise<void>;
}

const API_BASE = "https://api.migadu.com/v1";
const REQUEST_TIMEOUT_MS = 15000;

export function migaduMailboxApi(): MailboxApi {
    const admin = process.env.MIGADU_ADMIN_EMAIL;
    const key = process.env.MIGADU_API_KEY;
    const domain = process.env.MIGADU_DOMAIN || "myemailinfo.com";

    if (!admin || !key) {
        throw new Error("Mailbox creation is not set up (MIGADU_ADMIN_EMAIL / MIGADU_API_KEY missing)");
    }

    const authorization = `Basic ${Buffer.from(`${admin}:${key}`).toString("base64")}`;
    const base = `${API_BASE}/domains/${encodeURIComponent(domain)}/mailboxes`;

    async function call(method: string, localPart: string | null, body?: unknown): Promise<Response> {
        return fetch(localPart ? `${base}/${encodeURIComponent(localPart)}` : base, {
            method,
            headers: { Authorization: authorization, "Content-Type": "application/json" },
            body: body === undefined ? null : JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    }

    // Migadu's own message for a refused call (never includes our credentials).
    async function failure(res: Response, what: string): Promise<Error> {
        let detail = "";

        try {
            const payload = (await res.json()) as { error?: unknown };
            detail = typeof payload.error === "string" ? `: ${payload.error}` : "";
        } catch {
            // No JSON body - the status is enough.
        }

        return new Error(`Migadu ${what} failed (${res.status})${detail}`);
    }

    return {
        domain,

        async exists(localPart) {
            const res = await call("GET", localPart);

            if (res.status === 200) {
                return true;
            }

            if (res.status === 404) {
                return false;
            }

            throw await failure(res, "mailbox lookup");
        },

        async create(localPart, name, password) {
            const res = await call("POST", null, { name, local_part: localPart, password });

            if (!res.ok) {
                throw await failure(res, "mailbox creation");
            }
        },

        async remove(localPart) {
            const res = await call("DELETE", localPart);

            if (!res.ok && res.status !== 404) {
                throw await failure(res, "mailbox removal");
            }
        },
    };
}
