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

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html);
}

export function linkifyPlainText(text: string): string {
    const escaped = escapeHtml(text);
    const withLinks = escaped.replace(
        new RegExp(URL_PATTERN_SOURCE, "g"),
        (url) => `<a href="${url}">${url}</a>`
    );

    return DOMPurify.sanitize(withLinks);
}
