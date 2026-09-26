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
