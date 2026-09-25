import type { ThreadSummary } from "./types";

// Edugate codes are valid for 30 minutes (stated in every code email; the
// box above an opened thread reads the exact value from the email itself).
const CODE_VALID_MINUTES = 30;

// Step 18 phase 2: the one badge each thread shows (no more Pending/Closed
// tabs). Always English, short, one meaning per colour.
function Badge({ thread }: { thread: ThreadSummary }) {
    switch (thread.badge) {
        case "registered":
            return <span className="badge registered">REGISTERED</span>;
        case "rejected":
            return <span className="badge rejected">REJECTED</span>;
        case "used":
            return <span className="badge used">USED</span>;
        case "code": {
            const minutes = thread.code_at
                ? Math.max(0, Math.floor((Date.now() - new Date(thread.code_at).getTime()) / 60000))
                : 0;
            const expired = minutes >= CODE_VALID_MINUTES;
            return (
                <span className={expired ? "badge code expired" : "badge code"}>
                    {expired ? "CODE · expired" : `CODE · ${minutes < 1 ? "now" : `${minutes} min`}`}
                </span>
            );
        }
        case "new":
            return <span className="badge pending">NEW</span>;
        default:
            return <span className="badge replied">Replied</span>;
    }
}

const EDUGATE_BADGES = new Set<ThreadSummary["badge"]>(["registered", "rejected", "code", "used"]);

function shortTime(iso: string): string {
    return new Date(iso).toLocaleString([], {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    });
}

interface Props {
    threads: ThreadSummary[];
    selectedId: number | null;
    onSelect: (id: number) => void;
}

export default function MessageList({ threads, selectedId, onSelect }: Props) {
    if (threads.length === 0) {
        return <p className="empty-state">No messages.</p>;
    }

    return (
        <ul className="message-list">
            {threads.map((thread) => (
                <li
                    key={thread.threadId}
                    className={
                        [
                            "message-row",
                            thread.threadId === selectedId ? "selected" : "",
                            // Superseded codes only appear when searching.
                            thread.badge === "used" ? "used" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")
                    }
                    onClick={() => onSelect(thread.threadId)}
                >
                    <div className="message-row-top">
                        <span className="student-line">
                            <span className="student">
                                {thread.student_name ?? thread.student_email}
                            </span>
                            {thread.student_name && (
                                <span className="student-email">{thread.student_email}</span>
                            )}
                        </span>
                        <Badge thread={thread} />
                    </div>
                    <div className="message-row-line">
                        <span className="subject-sender">
                            <span className="subject">{thread.subject || "(no subject)"}</span>
                            {" · "}
                            {thread.sender_email}
                        </span>
                        <span className="received-at">{shortTime(thread.received_at)}</span>
                    </div>
                    {/* Edugate emails always open with the same boilerplate,
                        so their preview adds nothing; other emails (a
                        student's question) keep one line of it. */}
                    {thread.preview && !EDUGATE_BADGES.has(thread.badge) && (
                        <div className="message-preview">{thread.preview}</div>
                    )}
                    {thread.message_count > 1 && (
                        <div className="message-count">
                            {thread.message_count} messages in this thread
                        </div>
                    )}
                </li>
            ))}
        </ul>
    );
}
