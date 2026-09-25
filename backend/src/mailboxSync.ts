import { ImapFlow } from "imapflow";
import { syncInbox } from "./sync.js";
import { broadcast } from "./realtime.js";
import { db } from "./db.js";

const runningSync = new Set<string>();
// Set when a trigger arrives while a sync is already in flight for that
// mailbox - instead of just dropping it (which could leave a message
// arriving mid-sync waiting on the next IDLE event or fallback poll tick),
// the in-flight sync re-runs itself immediately once it finishes.
const pendingRerun = new Set<string>();
const activeWatchers = new Set<string>();

// Hard ceiling on a single sync run. imapflow has no documented per-call
// timeout, so a stalled network operation would otherwise hang forever -
// which, combined with the runningSync guard, would permanently block both
// future IDLE triggers and the fallback poll for that mailbox until the
// process was restarted. This guarantees runningSync always clears within
// bounded time regardless of what's hanging underneath.
const SYNC_WATCHDOG_MS = 45000;

function withWatchdog<T>(promise: Promise<T>, email: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`syncInbox [${email}] exceeded ${SYNC_WATCHDOG_MS}ms watchdog`));
        }, SYNC_WATCHDOG_MS);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

// Colleges the newly synced mail belongs to - each console only chimes for
// its own college. A lookup failure just means no chime, never a failed sync.
async function collegeIdsForStudents(emails: string[]): Promise<string[]> {
    if (emails.length === 0) {
        return [];
    }

    try {
        const result = await db.query<{ college_id: string }>(
            "SELECT DISTINCT college_id FROM students WHERE email = ANY($1) AND college_id IS NOT NULL",
            [emails]
        );
        return result.rows.map((row) => String(row.college_id));
    } catch (error) {
        console.error("collegeIdsForStudents failed:", error);
        return [];
    }
}

export async function triggerSync(
    email: string,
    password: string
): Promise<void> {
    if (runningSync.has(email)) {
        console.log(`[TIMING] triggerSync [${email}]: already running, queued a follow-up pass at ${new Date().toISOString()}`);
        pendingRerun.add(email);
        return;
    }

    runningSync.add(email);
    const start = Date.now();

    try {
        const { inserted, insertedStudentEmails } = await withWatchdog(syncInbox(email, password), email);
        const durationMs = Date.now() - start;

        if (inserted > 0) {
            console.log(`Sync [${email}]: ${inserted} new message(s) inserted (took ${durationMs}ms)`);
            const collegeIds = await collegeIdsForStudents(insertedStudentEmails);
            const broadcastAt = Date.now();
            broadcast("update", { reason: "new-mail", inserted, collegeIds }, email);
            console.log(`[TIMING] broadcast sent [${email}] at ${new Date(broadcastAt).toISOString()}`);
        } else {
            console.log(`[TIMING] Sync [${email}]: no new messages (took ${durationMs}ms)`);
        }
    } catch (error) {
        console.error(`Sync failed [${email}]:`, error);
    } finally {
        runningSync.delete(email);

        if (pendingRerun.delete(email)) {
            triggerSync(email, password);
        }
    }
}

export function ensureWatcher(email: string, password: string) {
    if (activeWatchers.has(email)) {
        return;
    }

    activeWatchers.add(email);

    startIdleWatcher(email, password).catch((error) => {
        console.error(`Idle watcher permanently failed [${email}]:`, error);
        activeWatchers.delete(email);
    });
}

async function startIdleWatcher(
    email: string,
    password: string
): Promise<never> {
    for (;;) {
        try {
            await watchOnce(email, password);
        } catch (error) {
            console.error(
                `IMAP idle watcher error [${email}], reconnecting in 5s:`,
                error
            );
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}

async function watchOnce(email: string, password: string): Promise<void> {
    const client = new ImapFlow({
        host: process.env.IMAP_HOST!,
        port: Number(process.env.IMAP_PORT || 993),
        secure: true,
        auth: { user: email, pass: password },
        logger: false,
    });

    await client.connect();

    // mailboxOpen() (not getMailboxLock()) is deliberate: a held mailbox
    // lock keeps imapflow's connectionBusy() true forever, which permanently
    // blocks its auto-IDLE (see autoidle() in imapflow's source - it bails
    // out whenever the connection is "busy"). Without auto-IDLE, the server
    // never gets told to push new-mail notifications, so "exists" only ever
    // fired via the 60s fallback poll - up to a minute of latency on every
    // new message. mailboxOpen() selects the mailbox without taking a lock,
    // so the connection goes idle and imapflow issues real IMAP IDLE ~15s
    // after going quiet, letting "exists" fire within seconds of new mail.
    await client.mailboxOpen("INBOX");

    client.on("exists", () => {
        console.log(`[TIMING] IDLE 'exists' fired [${email}] at ${new Date().toISOString()}`);
        triggerSync(email, password);
    });

    console.log(`IMAP idle watcher connected [${email}]`);

    await new Promise<void>((resolve, reject) => {
        client.on("close", () => resolve());
        client.on("error", (error: Error) => reject(error));
    });
}
