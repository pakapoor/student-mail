// Detects Migadu holding an email before storing it in the mailbox, from the
// Received headers Migadu stamps on every message:
//   - accepted: "by mizuN.migadu.com with ESMTPS" (inbound from outside) or
//     "by smtp.migadu.com with ESMTPS" (sent from one of our own mailboxes)
//   - stored:   "by soraStorageN.migadu.com with LMTP" (put into the mailbox)
// Normally both are within a second or two. On 25 Sep 2026 Migadu held
// inbound mail for 45 min – 5 h 44 m in one incident; this makes the next
// one show up in the logs on its own, with queue IDs for Migadu support.

const DELAY_WARN_MS = Number(process.env.MIGADU_DELAY_WARN_MIN || 5) * 60 * 1000;

export interface MigaduHold {
    acceptedAt: Date;
    storedAt: Date;
    holdMs: number;
    queueId: string | null;
}

function headerLines(source: Buffer): string[] {
    const text = source.toString("latin1");
    const end = text.search(/\r?\n\r?\n/);
    const header = end === -1 ? text : text.slice(0, end);
    // Unfold continuation lines so each header is one line.
    return header.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
}

function receivedTime(value: string): Date | null {
    const semicolon = value.lastIndexOf(";");

    if (semicolon === -1) {
        return null;
    }

    const date = new Date(value.slice(semicolon + 1).trim().replace(/\s*\(.*\)$/, ""));
    return Number.isNaN(date.getTime()) ? null : date;
}

export function migaduHold(source: Buffer): MigaduHold | null {
    const lines = headerLines(source);
    // Newest first, as stamped by each hop.
    const received = lines
        .filter((line) => /^received:/i.test(line))
        .map((line) => line.slice("received:".length).trim());

    const storedLine = received.find((r) => /by \S+\.migadu\.com with LMTP/i.test(r));
    // The last (oldest) Migadu acceptance - where the email entered Migadu.
    const acceptedLine = [...received].reverse().find((r) =>
        /by (?:mizu\d*|smtp)\.migadu\.com with E?SMTPS?A?\b/i.test(r)
    );

    if (!storedLine || !acceptedLine) {
        return null;
    }

    const storedAt = receivedTime(storedLine);
    const acceptedAt = receivedTime(acceptedLine);

    if (!storedAt || !acceptedAt) {
        return null;
    }

    const queueLine = lines.find((line) => /^x-migadu-queue-id:/i.test(line))
        ?? lines.find((line) => /^x-mizu-trace-id:/i.test(line));
    const queueId = queueLine ? queueLine.slice(queueLine.indexOf(":") + 1).trim() : null;

    return { acceptedAt, storedAt, holdMs: storedAt.getTime() - acceptedAt.getTime(), queueId };
}

// migaduHold, but never throws - measuring is diagnostics only and must
// never affect storing the email.
export function measureMigaduHold(source: Buffer | undefined): MigaduHold | null {
    try {
        return source ? migaduHold(source) : null;
    } catch {
        return null;
    }
}

// Logs one [migadu-delay] line if Migadu held this email longer than
// MIGADU_DELAY_WARN_MIN (default 5). The same hold is also stored on the
// message row (messages.migadu_hold_seconds / migadu_queue_id).
export function logMigaduDelay(
    hold: MigaduHold | null,
    context: { mailbox: string; messageId: string; senderEmail: string; students: string[] }
) {
    if (!hold || hold.holdMs < DELAY_WARN_MS) {
        return;
    }

    console.warn(
        `[migadu-delay] held=${Math.round(hold.holdMs / 60000)}m queue=${hold.queueId ?? "unknown"} ` +
            `accepted=${hold.acceptedAt.toISOString()} stored=${hold.storedAt.toISOString()} ` +
            `mailbox=${context.mailbox} from=${context.senderEmail} student=${context.students.join(",")} ` +
            `message=${context.messageId}`
    );
}
