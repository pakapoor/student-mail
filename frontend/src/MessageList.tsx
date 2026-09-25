import { useEffect, useState } from "react";
import type { ThreadSummary } from "./types";
import { shortDateTime } from "./format";

// Fallback only - the validity normally comes from the email itself
// ("valid for 30 minutes"), same as the box above an opened thread.
const CODE_VALID_MINUTES = 30;

// Step 18 phase 2: the one badge each thread shows (no more Pending/Closed
// tabs). Always English, short, one meaning per colour.
function Badge({ thread, now }: { thread: ThreadSummary; now: number }) {
    switch (thread.badge) {
        case "registered":
            return <span className="badge registered">REGISTERED</span>;
        case "rejected":
            return <span className="badge rejected">REJECTED</span>;
        case "used":
            return <span className="badge used">USED</span>;
        case "code": {
            const minutes = thread.code_at
                ? Math.max(0, Math.floor((now - new Date(thread.code_at).getTime()) / 60000))
                : 0;
            const expired = minutes >= (thread.code_valid_minutes ?? CODE_VALID_MINUTES);
            const age = minutes < 1 ? "now" : `${minutes} min`;

            if (expired) {
                return <span className="badge code expired">CODE · expired</span>;
            }

            // Still valid: show the code itself so staff don't have to open
            // the thread. It disappears once expired, so nobody copies a
            // stale code from the list.
            return (
                <span className="badge code">
                    {thread.code ? (
                        <>
                            CODE <span className="badge-code-value">{thread.code}</span> · {age}
                        </>
                    ) : (
                        `CODE · ${age}`
                    )}
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


interface Props {
    threads: ThreadSummary[];
    selectedId: number | null;
    onSelect: (id: number) => void;
    emptyText?: string;
}

export default function MessageList({ threads, selectedId, onSelect, emptyText }: Props) {
    // Ticks every 30 s so code ages - and the code disappearing once it
    // expires - stay current without reloading the list.
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
    }, []);

    if (threads.length === 0) {
        return <p className="empty-state">{emptyText ?? "No emails match."}</p>;
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
                        <Badge thread={thread} now={now} />
                    </div>
                    <div className="message-row-line">
                        <span className="subject-sender">
                            <span className="subject">{thread.title || thread.subject || "(no subject)"}</span>
                            {" · "}
                            {thread.sender_email}
                        </span>
                        <span className="received-at">{shortDateTime(thread.received_at)}</span>
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
