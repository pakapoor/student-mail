import { withSyncDeadline } from "./syncDeadline.js";
import { ImapFlow } from "imapflow";
import { SyncFailure, syncInbox } from "./sync.js";
import { broadcast } from "./realtime.js";
import { db } from "./db.js";
import { noteProblem, noteSyncSuccess, noteWatcher } from "./systemStatus.js";

const runningSync = new Set<string>();
// Set when a trigger arrives while a sync is already in flight for that
// mailbox - instead of just dropping it (which could leave a message
// arriving mid-sync waiting on the next IDLE event or fallback poll tick),
// the in-flight sync re-runs itself immediately once it finishes.
const pendingRerun = new Set<string>();
const activeWatchers = new Set<string>();

// The deadline aborts IMAP work; the running guard stays held until cleanup
// and any in-flight database statement settle.
const SYNC_WATCHDOG_MS = 45000;

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
        const { inserted, insertedStudentEmails, retryPending } = await withSyncDeadline((signal) => syncInbox(email, password, signal), SYNC_WATCHDOG_MS, email);
        noteSyncSuccess(email);

        // An email came back without content - try again shortly rather
        // than waiting for the next new mail / fallback poll.
        if (retryPending) {
            setTimeout(() => triggerSync(email, password), 5000);
        }
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
        noteProblem("sync-failed", email, `${email}: ${error instanceof Error ? error.message : String(error)}`);

        // Emails stored before the failure are committed but were never
        // announced - the next pass sees them as duplicates, so it's now or
        // never for the live update and chime.
        if (error instanceof SyncFailure && error.partial.inserted > 0) {
            const { inserted, insertedStudentEmails } = error.partial;
            const collegeIds = await collegeIdsForStudents(insertedStudentEmails);
            broadcast("update", { reason: "new-mail", inserted, collegeIds }, email);
            console.log(`[TIMING] broadcast sent for ${inserted} message(s) stored before the failure [${email}]`);
        }
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

        noteWatcher(email, false);

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
    noteWatcher(email, true);

    await new Promise<void>((resolve, reject) => {
        client.on("close", () => resolve());
        client.on("error", (error: Error) => reject(error));
    });
}
