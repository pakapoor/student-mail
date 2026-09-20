import DOMPurify from "dompurify";

// Make every link in sanitized email content open in a new tab instead of
// navigating the operator console away, and avoid leaking window.opener.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
    }
});

const URL_PATTERN_SOURCE = /(https?:\/\/[^\s<>"']+)/;

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html);
}

export function containsLink(html: string | null, text: string | null): boolean {
    if (html && /<a[\s>]/i.test(html)) {
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
