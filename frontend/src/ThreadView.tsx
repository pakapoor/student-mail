import { useEffect, useMemo, useRef, useState } from "react";
import type { IncomingThreadItem, ThreadItem } from "./types";
import { sendFollowUp, sendReply } from "./api";
import { linkifyPlainText, sanitizeHtml } from "./linkify";
import EmailFrame from "./EmailFrame";
import { findKeyInfo } from "./keyInfo";
import { classifyEdugate, edugateTitle } from "../../shared/edugate";
import { shortDateTime } from "./format";
import { isAutomatedSender } from "./automatedSender";
import KeyInfoBox from "./KeyInfoBox";

interface Props {
    items: ThreadItem[];
    onReplySent: () => void;
    // From the list row - shown under the heading.
    studentName?: string | null;
    studentAppNo?: string | null;
}

export default function ThreadView({ items, onReplySent, studentName, studentAppNo }: Props) {
    const editorRef = useRef<HTMLDivElement>(null);
    const [hasContent, setHasContent] = useState(false);
    const [files, setFiles] = useState<File[]>([]);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [justSent, setJustSent] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const subject =
        items.find((item) => item.type === "incoming")?.subject ||
        "(no subject)";

    const replyTarget = useMemo(() => {
        // A thread's pending status is timing-based, not "does every
        // individual message have its own reply": once you reply to (or
        // mark handled) anything in the thread, every incoming message up
        // to that point is considered addressed - only a message that
        // arrives *after* the most recent reply/mark-handled action still
        // needs attention. Mirrors thread.ts's latestResolvedAt on the
        // backend, computed here from the same thread items.
        let resolvedAt = -Infinity;

        for (const item of items) {
            if (item.type === "outgoing") {
                resolvedAt = Math.max(resolvedAt, new Date(item.at).getTime());
            } else if (item.handled_without_reply && item.replied_at) {
                resolvedAt = Math.max(resolvedAt, new Date(item.replied_at).getTime());
            }
        }

        // A verification code superseded by a later registration
        // (auto_closed) never needs a reply - same rule as the backend.
        const pending = items.filter(
            (item): item is IncomingThreadItem =>
                item.type === "incoming" &&
                !item.auto_closed &&
                new Date(item.at).getTime() > resolvedAt
        );

        if (pending.length === 0) {
            return null;
        }

        return pending.reduce((oldest, current) =>
            new Date(current.at) < new Date(oldest.at) ? current : oldest
        );
    }, [items]);

    // Used only when the thread is fully closed (replyTarget is null) -
    // lets the operator proactively send another message on an
    // already-resolved thread. The most recent incoming message carries the
    // right subject/recipient/threading headers to keep it in the same
    // email conversation.
    const mostRecentIncoming = useMemo(() => {
        const incoming = items.filter(
            (item): item is IncomingThreadItem => item.type === "incoming"
        );

        if (incoming.length === 0) {
            return null;
        }

        return incoming.reduce((latest, current) =>
            new Date(current.at) > new Date(latest.at) ? current : latest
        );
    }, [items]);

    const composeTarget = replyTarget ?? mostRecentIncoming;

    // Code / login credentials from a known sender's email (keyInfo.ts),
    // shown above the thread. null for everything else - no box.
    const keyInfo = useMemo(() => findKeyInfo(items), [items]);

    function removeFile(name: string) {
        setFiles((prev) => prev.filter((file) => file.name !== name));
    }

    function updateHasContent() {
        setHasContent((editorRef.current?.textContent?.trim().length ?? 0) > 0);
    }

    function applyFormat(
        command: "bold" | "italic" | "underline" | "insertUnorderedList" | "insertOrderedList"
    ) {
        editorRef.current?.focus();
        document.execCommand(command);
        updateHasContent();
    }

    function handleEditorKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
        const meta = e.ctrlKey || e.metaKey;

        if (!meta) {
            return;
        }

        if (e.key.toLowerCase() === "b") {
            e.preventDefault();
            applyFormat("bold");
        } else if (e.key.toLowerCase() === "i") {
            e.preventDefault();
            applyFormat("italic");
        } else if (e.key.toLowerCase() === "u") {
            e.preventDefault();
            applyFormat("underline");
        }
    }

    async function handleSend() {
        if (!composeTarget || !editorRef.current) {
            return;
        }

        setError(null);
        setSending(true);

        try {
            if (replyTarget) {
                await sendReply(replyTarget.id, editorRef.current.innerHTML, files);
            } else {
                await sendFollowUp(composeTarget.id, editorRef.current.innerHTML, files);
            }
            editorRef.current.innerHTML = "";
            setHasContent(false);
            setFiles([]);
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
            setJustSent(true);
            onReplySent();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to send message");
        } finally {
            setSending(false);
        }
    }

    return (
        <div className="thread-view">
            {/* Plain English for recognised Edugate emails (staff read
                English; every Edugate subject is "Edugate" or Russian). */}
            <h2>{keyInfo ? edugateTitle(keyInfo) : subject}</h2>
            <p className="thread-student">
                {studentName ? `${studentName} · ` : ""}
                {studentAppNo && <>Application No <span className="thread-app-no">{studentAppNo}</span> · </>}
                {items[0]?.student_email}
            </p>

            {keyInfo && <KeyInfoBox info={keyInfo} />}

            <div className="thread-items">
                {items.map((item) => (
                    item.type === "incoming" &&
                    classifyEdugate(item.sender_email, item.body_text, item.student_email) ? (
                        <CollapsedOriginal key={`${item.type}-${item.id}`} item={item} />
                    ) : (
                        <ThreadBubble key={`${item.type}-${item.id}`} item={item} />
                    )
                ))}
            </div>

            {justSent && !replyTarget && (
                <div className="success-card">
                    <span className="success-icon">&#10003;</span>
                    <div>
                        <p className="success-title">Message sent</p>
                        <p className="success-subtitle">
                            This thread is now up to date.
                        </p>
                    </div>
                </div>
            )}

            {composeTarget && isAutomatedSender(composeTarget.sender_email) ? (
                // Nobody reads replies to automated senders (Edugate etc.).
                <p className="no-reply-note">
                    Automated email from {composeTarget.sender_email}: replies aren't read, so there's
                    no reply box.
                </p>
            ) : composeTarget ? (
                <div className="reply-panel">
                    <h3>{replyTarget ? "Reply" : "Send another message"}</h3>
                    <p className="replying-as">
                        {replyTarget ? "Replying as" : "Sending as"}{" "}
                        <strong>{composeTarget.student_email}</strong>
                    </p>

                    <div className="composer-toolbar">
                        <button
                            type="button"
                            className="toolbar-button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyFormat("bold")}
                            disabled={sending}
                            aria-label="Bold"
                            title="Bold (Ctrl/Cmd+B)"
                        >
                            <strong>B</strong>
                        </button>
                        <button
                            type="button"
                            className="toolbar-button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyFormat("italic")}
                            disabled={sending}
                            aria-label="Italic"
                            title="Italic (Ctrl/Cmd+I)"
                        >
                            <em>I</em>
                        </button>
                        <button
                            type="button"
                            className="toolbar-button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyFormat("underline")}
                            disabled={sending}
                            aria-label="Underline"
                            title="Underline (Ctrl/Cmd+U)"
                        >
                            <u>U</u>
                        </button>

                        <span className="toolbar-divider" />

                        <button
                            type="button"
                            className="toolbar-button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyFormat("insertUnorderedList")}
                            disabled={sending}
                            aria-label="Bulleted list"
                            title="Bulleted list"
                        >
                            &bull; List
                        </button>
                        <button
                            type="button"
                            className="toolbar-button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyFormat("insertOrderedList")}
                            disabled={sending}
                            aria-label="Numbered list"
                            title="Numbered list"
                        >
                            1. List
                        </button>

                        <span className="toolbar-divider" />

                        <label className="file-picker toolbar-button">
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
                    </div>

                    <div className="rich-editor-wrapper">
                        {!hasContent && (
                            <span className="rich-editor-placeholder">
                                {replyTarget
                                    ? "Type the reply to send from the student's mailbox..."
                                    : "Type a message to send from the student's mailbox..."}
                            </span>
                        )}
                        <div
                            ref={editorRef}
                            className="rich-editor"
                            contentEditable={!sending}
                            spellCheck={true}
                            onInput={updateHasContent}
                            onKeyDown={handleEditorKeyDown}
                            role="textbox"
                            aria-multiline="true"
                            aria-label="Reply body"
                        />
                    </div>

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
                            disabled={sending || !hasContent}
                        >
                            {sending && <span className="spinner" />}
                            {sending ? "Sending" : replyTarget ? "Send reply" : "Send message"}
                        </button>
                    </div>
                </div>
            ) : (
                !justSent && (
                    <p className="empty-state">
                        This thread has no messages.
                    </p>
                )
            )}
        </div>
    );
}

const CLAMP_HEIGHT_PX = 420;

// A recognised Edugate email: the box above already shows everything that
// matters, so the original (big banner, Russian + English) is folded away
// behind a link instead of filling the screen.
function CollapsedOriginal({ item }: { item: IncomingThreadItem }) {
    const [open, setOpen] = useState(false);

    return (
        <div className="original-email">
            <button type="button" className="original-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                {open ? "▾ Hide original email" : "▸ Show original email"}
                <span className="original-meta">
                    {item.sender_email} · {shortDateTime(item.at)}
                </span>
            </button>
            {/* Opened on purpose - show the whole email, no second
                "Show full message" click. */}
            {open && <ThreadBubble item={item} full />}
        </div>
    );
}

// full: never shorten the body (used when the staff member explicitly opened
// a collapsed original email).
function ThreadBubble({ item, full = false }: { item: ThreadItem; full?: boolean }) {
    const renderedBody = useMemo(() => {
        if (item.type === "incoming" && item.body_html) {
            return sanitizeHtml(item.body_html);
        }

        // Outgoing replies' body_html was already sanitized server-side at
        // send time (sanitizeReplyHtml.ts) - it's our own composed content,
        // not untrusted external mail, so it's rendered as-is here rather
        // than re-run through the incoming-mail sanitizer, which assumes
        // different things (e.g. unwrapping mailto: links).
        if (item.type === "outgoing" && item.body_html) {
            return item.body_html;
        }

        return linkifyPlainText(
            item.body_text ||
                (item.type === "incoming" ? "(no body)" : "(reply text not recorded)")
        );
    }, [item]);

    // External HTML email goes in a sandboxed frame (EmailFrame.tsx); our
    // own replies and plain text are rendered inline as before.
    const inFrame = item.type === "incoming" && Boolean(item.body_html);

    const bodyRef = useRef<HTMLDivElement>(null);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const [expanded, setExpanded] = useState(false);

    // College/government letters are often long - only clamp (and only show
    // the toggle) when the content genuinely exceeds the cap, so short
    // replies never get an unnecessary "Show more" link.
    useEffect(() => {
        setExpanded(false);
        const el = bodyRef.current;
        setIsOverflowing(!!el && el.scrollHeight > CLAMP_HEIGHT_PX + 1);
    }, [renderedBody]);

    const bodyClassName =
        "bubble-body" + (!full && isOverflowing && !expanded ? " bubble-body-clamped" : "");

    const body = (
        <>
            {inFrame ? (
                <div ref={bodyRef} className={bodyClassName + " bubble-body-frame"}>
                    {/* The frame's height is only known once it loads. */}
                    <EmailFrame
                        html={renderedBody}
                        onHeightChange={(height) => setIsOverflowing(height > CLAMP_HEIGHT_PX + 1)}
                    />
                </div>
            ) : (
                <div
                    ref={bodyRef}
                    className={bodyClassName}
                    dangerouslySetInnerHTML={{ __html: renderedBody }}
                />
            )}
            {!full && isOverflowing && (
                <button
                    type="button"
                    className="bubble-expand-toggle"
                    onClick={() => setExpanded((prev) => !prev)}
                >
                    {expanded ? "Show less" : "Show full message"}
                </button>
            )}
        </>
    );

    if (item.type === "incoming") {
        return (
            <>
                <div className={inFrame ? "bubble bubble-incoming bubble-framed" : "bubble bubble-incoming"}>
                    <div className="bubble-meta">
                        <span className="bubble-from">{item.sender_email}</span>
                        <span className="bubble-time">
                            {shortDateTime(item.at)}
                        </span>
                    </div>
                    {body}
                </div>
                {item.handled_without_reply && (
                    <div className="system-note">Closed &mdash; no reply sent</div>
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
                    {shortDateTime(item.at)}
                </span>
            </div>
            {body}
            {item.attachment_count > 0 && (
                <div className="bubble-attachments">
                    {item.attachment_count} attachment
                    {item.attachment_count === 1 ? "" : "s"}
                </div>
            )}
        </div>
    );
}
