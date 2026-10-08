// Migadu mailbox API (https://api.migadu.com/v1). Basic auth: the admin account
// email plus an API key (My Account > API Keys; the login password does not
// work). Used only to create a student's mailbox when staff add students.

// A refusal or failure from the Migadu API itself (as opposed to our own code
// failing): the staff screen shows a plain message for it, the details go to the log.
export class MailboxApiError extends Error {}

// What the console needs to know about an existing mailbox: its name, and how
// many minutes ago it was created (null when that is not known or it is older
// than today - Migadu shows the creation time only as "06:06" for today, and
// as a date like "29/09/26" for earlier days).
export interface MailboxInfo {
    name: string;
    createdMinutesAgo: number | null;
}

// Minutes since a creation time Migadu shows as "HH:MM" (UTC, today); null for
// anything else (a date, missing) or a time in the future.
export function minutesSinceCreated(value: unknown, now: Date = new Date()): number | null {
    const match = typeof value === "string" ? value.match(/^(\d{2}):(\d{2})$/) : null;

    if (!match) {
        return null;
    }

    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes() - (Number(match[1]) * 60 + Number(match[2]));
    // A minute or so ahead is clock difference; more than that is not today's time.
    return minutes < -1 ? null : Math.max(0, minutes);
}

// One call to the Migadu API as it was timed: what it was, how long it took
// (to the answer's headers), and how it ended. A 404 on a lookup or a removal
// is a normal answer ("no such mailbox"), not a failure.
export type CallOperation = "lookup" | "create" | "remove";
export type CallOutcome = "ok" | "refused" | "server-error" | "timeout" | "network";
export interface TimedCall {
    operation: CallOperation;
    ms: number;
    outcome: CallOutcome;
}

export function callOutcome(operation: CallOperation, status: number): CallOutcome {
    if (status >= 200 && status < 300) {
        return "ok";
    }

    if (status === 404 && operation !== "create") {
        return "ok";
    }

    return status >= 500 ? "server-error" : "refused";
}

export interface MailboxApi {
    domain: string;
    exists(localPart: string): Promise<boolean>;
    inspect(localPart: string): Promise<MailboxInfo | null>;
    create(localPart: string, name: string, password: string): Promise<void>;
    remove(localPart: string): Promise<void>;
}

const API_BASE = "https://api.migadu.com/v1";
// Each call to Migadu waits at most this long.
export const REQUEST_TIMEOUT_MS = 20000;

export function migaduMailboxApi(onCall?: (call: TimedCall) => void): MailboxApi {
    const admin = process.env.MIGADU_ADMIN_EMAIL;
    const key = process.env.MIGADU_API_KEY;
    const domain = process.env.MIGADU_DOMAIN || "myemailinfo.com";

    if (!admin || !key) {
        throw new Error("Mailbox creation is not set up (MIGADU_ADMIN_EMAIL / MIGADU_API_KEY missing)");
    }

    const authorization = `Basic ${Buffer.from(`${admin}:${key}`).toString("base64")}`;
    const base = `${API_BASE}/domains/${encodeURIComponent(domain)}/mailboxes`;

    const operations: Record<string, CallOperation> = { GET: "lookup", POST: "create", DELETE: "remove" };

    async function call(method: string, localPart: string | null, body?: unknown): Promise<Response> {
        const operation = operations[method] ?? "lookup";
        const started = Date.now();
        let outcome: CallOutcome = "network";

        try {
            const res = await fetch(localPart ? `${base}/${encodeURIComponent(localPart)}` : base, {
                method,
                headers: { Authorization: authorization, "Content-Type": "application/json" },
                body: body === undefined ? null : JSON.stringify(body),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            outcome = callOutcome(operation, res.status);
            return res;
        } catch (error) {
            outcome = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
            throw error;
        } finally {
            // Recording must never break an add: whatever the recorder does, it is ignored.
            try {
                onCall?.({ operation, ms: Date.now() - started, outcome });
            } catch {
                // ignore
            }
        }
    }

    // Migadu's own message for a refused call (never includes our credentials).
    async function failure(res: Response, what: string): Promise<MailboxApiError> {
        let detail = "";

        try {
            const payload = (await res.json()) as { error?: unknown };
            detail = typeof payload.error === "string" ? `: ${payload.error}` : "";
        } catch {
            // No JSON body - the status is enough.
        }

        return new MailboxApiError(`Migadu ${what} failed (${res.status})${detail}`);
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

        async inspect(localPart) {
            const res = await call("GET", localPart);

            if (res.status === 404) {
                return null;
            }

            if (!res.ok) {
                throw await failure(res, "mailbox lookup");
            }

            const body = (await res.json()) as { name?: unknown; activated_at?: unknown };
            return {
                name: typeof body.name === "string" ? body.name : "",
                createdMinutesAgo: minutesSinceCreated(body.activated_at),
            };
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
