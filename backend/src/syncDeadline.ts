// Abort on deadline, but never abandon the operation's cleanup. In
// particular, a pending DB write must finish before a successor can start.
// A run that still completes after the abort did finish its work (its
// watermark is written), so its result is kept rather than turned into a
// failure - otherwise the emails it stored would never be announced.
export async function withSyncDeadline<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    mailbox: string
): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new Error(`syncInbox [${mailbox}] exceeded ${timeoutMs}ms deadline`));
    }, timeoutMs);
    try {
        return await run(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

// Step 52: the last resort behind withSyncDeadline. If the work still has not
// settled `ms` after it started (the deadline's abort did not make it finish),
// stop waiting: reject with SyncAbandoned so the caller can release its guard
// and let the next pass run. The abandoned work keeps running on its own; its
// eventual result or error is swallowed here.
export class SyncAbandoned extends Error {}

export async function withHardLimit<T>(work: Promise<T>, ms: number, mailbox: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            work.catch(() => {});
            reject(new SyncAbandoned(`syncInbox [${mailbox}] did not settle within ${ms}ms; abandoned so the next pass can run`));
        }, ms);
    });

    try {
        return await Promise.race([work, limit]);
    } finally {
        clearTimeout(timer);
    }
}
