import { useEffect, useRef } from "react";

// Incoming email HTML is shown in a sandboxed iframe, not injected into the
// console page (Step 25). DOMPurify (sanitizeHtml) still strips scripts
// first; the frame then also:
// - isolates the email's own <style> rules, which used to apply to the
//   whole console;
// - blocks forms (no allow-forms) and scripts (no allow-scripts), so a
//   fake "re-enter your password" form can't submit anywhere.
// allow-same-origin (without allow-scripts) only lets the console measure
// the content height; the email itself still can't run any code.
// Links open in a new tab (allow-popups + <base target="_blank">).
const SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

// Matches the console's .bubble-body text so a plain email looks the same.
const FRAME_STYLE = `
    html, body { margin: 0; padding: 0; }
    body {
        font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
        font-size: 14px;
        line-height: 1.55;
        color: #16213a;
        overflow-wrap: anywhere;
    }
    a { color: #173d8f; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
`;

function frameDocument(sanitizedHtml: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${FRAME_STYLE}</style></head><body>${sanitizedHtml}</body></html>`;
}

export default function EmailFrame({
    html,
    onHeightChange,
}: {
    // Already sanitized (linkify.ts sanitizeHtml).
    html: string;
    onHeightChange?: (height: number) => void;
}) {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const onHeightRef = useRef(onHeightChange);

    useEffect(() => {
        onHeightRef.current = onHeightChange;
    }, [onHeightChange]);

    useEffect(() => {
        const frame = frameRef.current;

        if (!frame) {
            return;
        }

        let observer: ResizeObserver | undefined;

        // Size the frame to its content, and keep it sized as images load.
        const fit = () => {
            const doc = frame.contentDocument;

            if (!doc?.documentElement) {
                return;
            }

            const height = Math.ceil(doc.documentElement.scrollHeight);
            frame.style.height = `${height}px`;
            onHeightRef.current?.(height);
        };

        const onLoad = () => {
            fit();
            observer?.disconnect();

            if (frame.contentDocument?.body && typeof ResizeObserver !== "undefined") {
                observer = new ResizeObserver(fit);
                observer.observe(frame.contentDocument.body);
            }
        };

        frame.addEventListener("load", onLoad);

        return () => {
            frame.removeEventListener("load", onLoad);
            observer?.disconnect();
        };
    }, []);

    return (
        <iframe
            ref={frameRef}
            className="email-frame"
            title="Email content"
            sandbox={SANDBOX}
            srcDoc={frameDocument(html)}
        />
    );
}
