import { db } from "./db.js";
import { registerStatusProvider } from "./systemStatus.js";

// The Add students log (Step 48). Every event of adding a student - mailbox
// created / reused / removed, student saved / skipped / failed, test email sent /
// received / not received - is (1) written to the server log as an [audit] line,
// found with `journalctl -u student-mail | grep '\[audit\]'`, and (2) stored in
// student_add_log for 30 days so the status page can list it. Staff share one
// login, so who did it is the central mailbox, the college and the client's IP
// address. Never contains a password. Recording never throws.

const KEEP_DAYS = 30;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPrune = 0;

export function pruneOldEntries(): Promise<unknown> {
    return db.query(`DELETE FROM student_add_log WHERE at < now() - interval '${KEEP_DAYS} days'`);
}

// Resolves once the row is stored (or storing failed - that is only logged), so a
// caller that needs the entry for its next decision can wait for it.
export async function audit(event: string, details: Record<string, unknown>): Promise<void> {
    const at = new Date().toISOString();
    console.log(`[audit] ${JSON.stringify({ at, event, ...details })}`);

    if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        pruneOldEntries().catch(() => {});
    }

    try {
        await db.query("INSERT INTO student_add_log (at, event, details) VALUES ($1, $2, $3)", [at, event, JSON.stringify(details)]);
    } catch (error) {
        console.error("Could not store an Add students log entry:", error instanceof Error ? error.message : error);
    }
}

const WINDOW_DAYS = 7;
const SHOW_LIMIT = 500;

export interface AddLogEntry {
    at: string;
    event: string;
    [key: string]: unknown;
}

// The status page card: the last 7 days, newest first (at most 500 entries).
export async function addLogStatus() {
    const result = await db.query<{ at: Date; event: string; details: Record<string, unknown> | null }>(
        `SELECT at, event, details FROM student_add_log
         WHERE at > now() - interval '${WINDOW_DAYS} days'
         ORDER BY at DESC, id DESC LIMIT ${SHOW_LIMIT}`
    );

    return {
        windowDays: WINDOW_DAYS,
        limit: SHOW_LIMIT,
        entries: result.rows.map((r): AddLogEntry => ({ ...(r.details ?? {}), at: r.at.toISOString(), event: r.event })),
    };
}

registerStatusProvider("addLog", addLogStatus);
