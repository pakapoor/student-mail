import type { ThreadSummary } from "./types";

interface Props {
    threads: ThreadSummary[];
    selectedId: number | null;
    onSelect: (id: number) => void;
}

export default function MessageList({ threads, selectedId, onSelect }: Props) {
    if (threads.length === 0) {
        return <p className="empty-state">No messages in this view.</p>;
    }

    return (
        <ul className="message-list">
            {threads.map((thread) => (
                <li
                    key={thread.threadId}
                    className={
                        thread.threadId === selectedId
                            ? "message-row selected"
                            : "message-row"
                    }
                    onClick={() => onSelect(thread.threadId)}
                >
                    <div className="message-row-top">
                        <span className="student">{thread.student_email}</span>
                        <span
                            className={
                                thread.pending_count > 0 ? "badge pending" : "badge replied"
                            }
                        >
                            {thread.pending_count > 0
                                ? `${thread.pending_count} pending`
                                : "Replied"}
                        </span>
                    </div>
                    <div className="subject">{thread.subject || "(no subject)"}</div>
                    {thread.preview && <div className="message-preview">{thread.preview}</div>}
                    <div className="message-row-bottom">
                        <span className="sender">{thread.sender_email}</span>
                        <span className="received-at">
                            {new Date(thread.received_at).toLocaleString()}
                        </span>
                    </div>
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
