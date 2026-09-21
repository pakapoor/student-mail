import { ImapFlow } from "imapflow";
import { syncInbox } from "./sync.js";
import { broadcast } from "./realtime.js";

const runningSync = new Set<string>();
const activeWatchers = new Set<string>();

export async function triggerSync(
    email: string,
    password: string
): Promise<void> {
    if (runningSync.has(email)) {
        return;
    }

    runningSync.add(email);

    try {
        const { inserted } = await syncInbox(email, password);

        if (inserted > 0) {
            console.log(`Sync [${email}]: ${inserted} new message(s) inserted`);
            broadcast("update", { reason: "new-mail", inserted }, email);
        }
    } catch (error) {
        console.error(`Sync failed [${email}]:`, error);
    } finally {
        runningSync.delete(email);
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
        triggerSync(email, password);
    });

    console.log(`IMAP idle watcher connected [${email}]`);

    await new Promise<void>((resolve, reject) => {
        client.on("close", () => resolve());
        client.on("error", (error: Error) => reject(error));
    });
}
