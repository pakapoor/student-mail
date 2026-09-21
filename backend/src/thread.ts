import { db } from "./db.js";

interface MessageRow {
    id: number;
    message_id: string;
    student_email: string;
    sender_email: string;
    subject: string | null;
    received_at: string;
    replied: boolean;
    replied_at: string | null;
    body_text: string | null;
    body_html: string | null;
    in_reply_to: string | null;
    reference_ids: string[];
    handled_without_reply: boolean;
}

interface ReplyRow {
    id: number;
    incoming_message_id: string;
    student_email: string;
    recipient_email: string;
    sent_message_id: string | null;
    sent_at: string;
    attachment_count: number;
    body_text: string | null;
}

export interface IncomingThreadItem {
    type: "incoming";
    id: number;
    message_id: string;
    student_email: string;
    sender_email: string;
    subject: string | null;
    at: string;
    replied: boolean;
    replied_at: string | null;
    body_text: string | null;
    body_html: string | null;
    handled_without_reply: boolean;
}

export interface OutgoingThreadItem {
    type: "outgoing";
    id: number;
    incoming_message_id: string;
    student_email: string;
    recipient_email: string;
    sent_message_id: string | null;
    at: string;
    attachment_count: number;
    body_text: string | null;
}

export type ThreadItem = IncomingThreadItem | OutgoingThreadItem;

class UnionFind {
    private parent = new Map<string, string>();

    find(x: string): string {
        const existing = this.parent.get(x);

        if (!existing) {
            this.parent.set(x, x);
            return x;
        }

        if (existing === x) {
            return x;
        }

        const root = this.find(existing);
        this.parent.set(x, root);
        return root;
    }

    union(a: string, b: string) {
        const rootA = this.find(a);
        const rootB = this.find(b);

        if (rootA !== rootB) {
            this.parent.set(rootA, rootB);
        }
    }
}

// A thread is "pending" based on timing, not on whether every individual
// message has its own replied=true row: once you reply to (or mark handled)
// anything in a thread, every incoming message up to that point is
// considered addressed, even if several arrived before you got to reply -
// you don't need a separate reply per message in a burst, only per new
// message that arrives *after* your last action. Each message's own
// `replied` column is left untouched for that message's own record; this
// only changes how thread-level pending status is computed from it.
function latestResolvedAt(
    threadMessages: MessageRow[],
    threadReplies: ReplyRow[]
): number {
    let latest = -Infinity;

    for (const r of threadReplies) {
        latest = Math.max(latest, new Date(r.sent_at).getTime());
    }

    for (const m of threadMessages) {
        if (m.handled_without_reply && m.replied_at) {
            latest = Math.max(latest, new Date(m.replied_at).getTime());
        }
    }

    return latest;
}

function stillPending(message: MessageRow, resolvedAt: number): boolean {
    return new Date(message.received_at).getTime() > resolvedAt;
}

async function fetchAllMessages(
    centralEmail: string,
    collegeId: string
): Promise<MessageRow[]> {
    // Soft-deleted students' messages stay in the DB but must be invisible
    // everywhere in the console (including thread grouping) until restored.
    // A message only counts as visible if its student is active and belongs
    // to the selected college.
    const result = await db.query<MessageRow>(
        `
        SELECT id, message_id, student_email, sender_email, subject, received_at,
               replied, replied_at, body_text, body_html, in_reply_to, reference_ids,
               handled_without_reply
        FROM messages
        WHERE central_email = $1
          AND EXISTS (
              SELECT 1 FROM students s
              WHERE s.email = messages.student_email
                AND s.deleted_at IS NULL
                AND s.college_id = $2
          )
        `,
        [centralEmail, collegeId]
    );

    return result.rows;
}

async function fetchAllReplies(): Promise<ReplyRow[]> {
    const result = await db.query<ReplyRow>(
        `
        SELECT id, incoming_message_id, student_email, recipient_email,
               sent_message_id, sent_at, attachment_count, body_text
        FROM replies
        `
    );

    return result.rows;
}

function groupIntoThreads(messages: MessageRow[]): MessageRow[][] {
    const uf = new UnionFind();

    for (const m of messages) {
        const ids = [m.message_id, m.in_reply_to, ...(m.reference_ids || [])].filter(
            (v): v is string => Boolean(v)
        );

        for (const id of ids) {
            uf.union(m.message_id, id);
        }
    }

    const groups = new Map<string, MessageRow[]>();

    for (const m of messages) {
        const root = uf.find(m.message_id);
        const list = groups.get(root);

        if (list) {
            list.push(m);
        } else {
            groups.set(root, [m]);
        }
    }

    return [...groups.values()];
}

async function fetchMessagesForStudentEmails(
    emails: string[]
): Promise<MessageRow[]> {
    if (emails.length === 0) {
        return [];
    }

    const result = await db.query<MessageRow>(
        `
        SELECT id, message_id, student_email, sender_email, subject, received_at,
               replied, replied_at, body_text, body_html, in_reply_to, reference_ids,
               handled_without_reply
        FROM messages
        WHERE student_email = ANY($1)
        `,
        [emails]
    );

    return result.rows;
}

// Cross-operator (not scoped to one central_email) count of effectively-
// pending messages per student email, using the same timing-based
// definition as fetchThreadSummaries/fetchThread - a message only counts if
// nothing newer than it has been replied to/marked handled in its thread.
// Used by the admin roster's delete-confirmation warning so it matches what
// the console actually shows as pending, rather than a stricter raw count.
export async function countEffectivelyPendingByEmail(
    emails: string[]
): Promise<Record<string, number>> {
    const messages = await fetchMessagesForStudentEmails(emails);

    if (messages.length === 0) {
        return {};
    }

    const threadGroups = groupIntoThreads(messages);
    const allReplies = await fetchAllReplies();
    const counts: Record<string, number> = {};

    for (const groupMessages of threadGroups) {
        const threadMessageIds = new Set(groupMessages.map((m) => m.message_id));
        const threadReplies = allReplies.filter((r) =>
            threadMessageIds.has(r.incoming_message_id)
        );
        const resolvedAt = latestResolvedAt(groupMessages, threadReplies);

        for (const m of groupMessages) {
            if (stillPending(m, resolvedAt)) {
                counts[m.student_email] = (counts[m.student_email] || 0) + 1;
            }
        }
    }

    return counts;
}

export async function fetchThread(
    messageId: number,
    centralEmail: string,
    collegeId: string
): Promise<ThreadItem[] | null> {
    const messages = await fetchAllMessages(centralEmail, collegeId);
    const target = messages.find((m) => Number(m.id) === messageId);

    if (!target) {
        return null;
    }

    const threadGroups = groupIntoThreads(messages);
    const threadMessages =
        threadGroups.find((group) =>
            group.some((m) => m.message_id === target.message_id)
        ) || [];

    const threadMessageIds = new Set(threadMessages.map((m) => m.message_id));

    const allReplies = await fetchAllReplies();

    const threadReplies = allReplies.filter((r) =>
        threadMessageIds.has(r.incoming_message_id)
    );

    const items: ThreadItem[] = [
        ...threadMessages.map(
            (m): IncomingThreadItem => ({
                type: "incoming",
                id: m.id,
                message_id: m.message_id,
                student_email: m.student_email,
                sender_email: m.sender_email,
                subject: m.subject,
                at: m.received_at,
                replied: m.replied,
                replied_at: m.replied_at,
                body_text: m.body_text,
                body_html: m.body_html,
                handled_without_reply: m.handled_without_reply,
            })
        ),
        ...threadReplies.map(
            (r): OutgoingThreadItem => ({
                type: "outgoing",
                id: r.id,
                incoming_message_id: r.incoming_message_id,
                student_email: r.student_email,
                recipient_email: r.recipient_email,
                sent_message_id: r.sent_message_id,
                at: r.sent_at,
                attachment_count: r.attachment_count,
                body_text: r.body_text,
            })
        ),
    ];

    items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return items;
}

export interface ThreadSummary {
    threadId: number;
    subject: string | null;
    student_email: string;
    sender_email: string;
    received_at: string;
    message_count: number;
    pending_count: number;
}

export interface ThreadSummaryPage {
    threads: ThreadSummary[];
    total: number;
    hasMore: boolean;
}

export async function fetchThreadSummaries(
    status: "pending" | "replied",
    centralEmail: string,
    collegeId: string,
    limit = 25,
    offset = 0
): Promise<ThreadSummaryPage> {
    const messages = await fetchAllMessages(centralEmail, collegeId);
    const threadGroups = groupIntoThreads(messages);
    const allReplies = await fetchAllReplies();

    const summaries: ThreadSummary[] = threadGroups.map((groupMessages) => {
        const latest = groupMessages.reduce((a, b) =>
            new Date(b.received_at) > new Date(a.received_at) ? b : a
        );

        const threadMessageIds = new Set(groupMessages.map((m) => m.message_id));
        const threadReplies = allReplies.filter((r) =>
            threadMessageIds.has(r.incoming_message_id)
        );
        const resolvedAt = latestResolvedAt(groupMessages, threadReplies);

        const pending = groupMessages.filter((m) => stillPending(m, resolvedAt));
        const pendingCount = pending.length;

        const representative =
            pendingCount > 0
                ? pending.reduce((a, b) =>
                      new Date(b.received_at) < new Date(a.received_at) ? b : a
                  )
                : latest;

        return {
            threadId: representative.id,
            subject: latest.subject,
            student_email: latest.student_email,
            sender_email: latest.sender_email,
            received_at: latest.received_at,
            message_count: groupMessages.length,
            pending_count: pendingCount,
        };
    });

    const filtered = summaries.filter((s) =>
        status === "pending" ? s.pending_count > 0 : s.pending_count === 0
    );

    // Thread list is always newest-first, regardless of status filter. This
    // only orders which threads appear where in the list - it doesn't change
    // which individual message within a thread is offered up for reply
    // (that's still always the oldest unreplied message in that thread).
    filtered.sort(
        (a, b) =>
            new Date(b.received_at).getTime() - new Date(a.received_at).getTime()
    );

    const page = filtered.slice(offset, offset + limit);

    return {
        threads: page,
        total: filtered.length,
        hasMore: offset + limit < filtered.length,
    };
}
