import DOMPurify from "dompurify";

// Make every link in sanitized email content open in a new tab instead of
// navigating the operator console away, and avoid leaking window.opener.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
        const href = node.getAttribute("href") || "";

        if (href.toLowerCase().startsWith("mailto:")) {
            // Mail clients (Gmail included) auto-linkify quoted email
            // addresses as mailto: anchors - that's not an actionable link,
            // so it shouldn't look clickable either. Reduce it to plain text.
            const text = (node.ownerDocument || document).createTextNode(
                node.textContent || ""
            );
            node.replaceWith(text);
            return;
        }

        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
    }
});

const URL_PATTERN_SOURCE = /(https?:\/\/[^\s<>"']+)/;

// Only an <a href="http(s)://..."> counts as a real link needing attention.
// Mail clients (Gmail included) auto-linkify quoted email addresses as
// mailto: anchors (e.g. "On ... <student@domain> wrote:") - that's not an
// actionable link, so it must not trigger the "open link before marking
// handled" warning.
const HTTP_ANCHOR_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']https?:\/\/[^"']+["']/i;

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html);
}

// Matches common automated/no-reply sender local-parts (donotreply@,
// do-not-reply@, noreply@, no-reply@, ...). "Mark as handled" only makes
// sense for messages that genuinely can't be replied to meaningfully - an
// automated notification, not a real person/office waiting on a response.
const AUTOMATED_SENDER_PATTERN = /^(do[-._]?not[-._]?reply|no[-._]?reply)@/i;

export function isAutomatedSender(email: string | null | undefined): boolean {
    return !!email && AUTOMATED_SENDER_PATTERN.test(email.trim());
}

export function containsLink(html: string | null, text: string | null): boolean {
    if (html && HTTP_ANCHOR_PATTERN.test(html)) {
        return true;
    }

    const source = html || text || "";
    return URL_PATTERN_SOURCE.test(source);
}

export function linkifyPlainText(text: string): string {
    const escaped = escapeHtml(text);
    const withLinks = escaped.replace(
        new RegExp(URL_PATTERN_SOURCE, "g"),
        (url) => `<a href="${url}">${url}</a>`
    );

    return DOMPurify.sanitize(withLinks);
}
