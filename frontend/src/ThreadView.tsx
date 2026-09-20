import { useMemo, useRef, useState } from "react";
import type { IncomingThreadItem, ThreadItem } from "./types";
import { markHandled, sendReply } from "./api";
import { containsLink, linkifyPlainText, sanitizeHtml } from "./linkify";

interface Props {
    items: ThreadItem[];
    onReplySent: () => void;
}

export default function ThreadView({ items, onReplySent }: Props) {
    const [body, setBody] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [sending, setSending] = useState(false);
    const [markingHandled, setMarkingHandled] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [justSent, setJustSent] = useState(false);
    const [clickedLinkIds, setClickedLinkIds] = useState<Set<number>>(new Set());
    const fileInputRef = useRef<HTMLInputElement>(null);

    const subject =
        items.find((item) => item.type === "incoming")?.subject ||
        "(no subject)";

    const replyTarget = useMemo(() => {
        const pending = items.filter(
            (item): item is IncomingThreadItem =>
                item.type === "incoming" && !item.replied
        );

        if (pending.length === 0) {
            return null;
        }

        return pending.reduce((oldest, current) =>
            new Date(current.at) < new Date(oldest.at) ? current : oldest
        );
    }, [items]);

    const replyTargetHasLink = replyTarget
        ? containsLink(replyTarget.body_html, replyTarget.body_text)
        : false;

    const linkNotYetClicked =
        replyTarget !== null &&
        replyTargetHasLink &&
        !clickedLinkIds.has(replyTarget.id);

    function handleLinkClick(itemId: number) {
        setClickedLinkIds((prev) => {
            const next = new Set(prev);
            next.add(itemId);
            return next;
        });
    }

    function removeFile(name: string) {
        setFiles((prev) => prev.filter((file) => file.name !== name));
    }

    async function handleSend() {
        if (!replyTarget) {
            return;
        }

        setError(null);
        setSending(true);

        try {
            await sendReply(replyTarget.id, body, files);
            setBody("");
            setFiles([]);
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
            setJustSent(true);
            onReplySent();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to send reply");
        } finally {
            setSending(false);
        }
    }

    async function handleMarkHandled() {
        if (!replyTarget) {
            return;
        }

        setError(null);
        setMarkingHandled(true);

        try {
            await markHandled(replyTarget.id);
            setJustSent(true);
            onReplySent();
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Failed to mark as handled"
            );
        } finally {
            setMarkingHandled(false);
        }
    }

    return (
        <div className="thread-view">
            <h2>{subject}</h2>

            <div className="thread-items">
                {items.map((item) => (
                    <ThreadBubble
                        key={`${item.type}-${item.id}`}
                        item={item}
                        onLinkClick={handleLinkClick}
                    />
                ))}
            </div>

            {justSent && !replyTarget && (
                <div className="success-card">
                    <span className="success-icon">&#10003;</span>
                    <div>
                        <p className="success-title">Done</p>
                        <p className="success-subtitle">
                            This thread is now up to date.
                        </p>
                    </div>
                </div>
            )}

            {replyTarget ? (
                <div className="reply-panel">
                    <h3>Reply</h3>

                    <textarea
                        rows={5}
                        placeholder="Type the reply to send from the student's mailbox..."
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        disabled={sending}
                    />

                    <label className="file-picker">
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            onChange={(e) =>
                                setFiles(Array.from(e.target.files || []))
                            }
                            disabled={sending}
                        />
                        Attach files
                    </label>

                    {files.length > 0 && (
                        <ul className="attachment-list">
                            {files.map((file) => (
                                <li key={file.name}>
                                    <span>{file.name}</span>
                                    {!sending && (
                                        <button
                                            type="button"
                                            className="remove-attachment"
                                            onClick={() => removeFile(file.name)}
                                            aria-label={`Remove ${file.name}`}
                                        >
                                            &times;
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    {error && <p className="error">{error}</p>}

                    <div className="reply-actions">
                        <button
                            className="send-button"
                            onClick={handleSend}
                            disabled={sending || markingHandled || body.trim().length === 0}
                        >
                            {sending && <span className="spinner" />}
                            {sending ? "Sending" : "Send reply"}
                        </button>

                        <button
                            className="secondary-button"
                            onClick={handleMarkHandled}
                            disabled={sending || markingHandled || linkNotYetClicked}
                            title={
                                linkNotYetClicked
                                    ? "Open the link in this message before marking it handled"
                                    : undefined
                            }
                        >
                            {markingHandled && <span className="spinner spinner-dark" />}
                            {markingHandled ? "Marking..." : "Mark as handled"}
                        </button>
                    </div>

                    {linkNotYetClicked && (
                        <p className="hint-text">
                            This message contains a link. Open it at least once before
                            marking it handled, in case it needs action (e.g. a
                            verification link).
                        </p>
                    )}
                </div>
            ) : (
                !justSent && (
                    <p className="empty-state">
                        This thread has no pending messages.
                    </p>
                )
            )}
        </div>
    );
}

function ThreadBubble({
    item,
    onLinkClick,
}: {
    item: ThreadItem;
    onLinkClick: (itemId: number) => void;
}) {
    const renderedBody = useMemo(() => {
        if (item.type === "incoming" && item.body_html) {
            return sanitizeHtml(item.body_html);
        }

        return linkifyPlainText(
            item.body_text ||
                (item.type === "incoming" ? "(no body)" : "(reply text not recorded)")
        );
    }, [item]);

    function handleBodyClick(e: React.MouseEvent<HTMLDivElement>) {
        const target = e.target as HTMLElement;
        if (target.tagName === "A") {
            onLinkClick(item.id);
        }
    }

    if (item.type === "incoming") {
        return (
            <>
                <div className="bubble bubble-incoming">
                    <div className="bubble-meta">
                        <span className="bubble-from">{item.sender_email}</span>
                        <span className="bubble-time">
                            {new Date(item.at).toLocaleString()}
                        </span>
                    </div>
                    <div
                        className="bubble-body"
                        onClick={handleBodyClick}
                        dangerouslySetInnerHTML={{ __html: renderedBody }}
                    />
                </div>
                {item.handled_without_reply && (
                    <div className="system-note">Marked as handled &mdash; no reply sent</div>
                )}
            </>
        );
    }

    return (
        <div className="bubble bubble-outgoing">
            <div className="bubble-meta">
                <span className="bubble-from">
                    {item.student_email} &rarr; {item.recipient_email}
                </span>
                <span className="bubble-time">
                    {new Date(item.at).toLocaleString()}
                </span>
            </div>
            <div
                className="bubble-body"
                dangerouslySetInnerHTML={{ __html: renderedBody }}
            />
            {item.attachment_count > 0 && (
                <div className="bubble-attachments">
                    {item.attachment_count} attachment
                    {item.attachment_count === 1 ? "" : "s"}
                </div>
            )}
        </div>
    );
}
