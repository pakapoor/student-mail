// Composer output only ever needs Bold/Italic/line breaks (Step 13's scope),
// so this is a narrow allowlist, not a general HTML sanitizer: every tag not
// in ALLOWED_TAGS is stripped (including all attributes on tags that ARE
// allowed - e.g. onmouseover="..." on a <b> is dropped, not just ignored).
// This is the actual trust boundary - a request can reach this endpoint
// without going through the browser's contentEditable serialization at all,
// so sanitizing here (not just in the frontend) is what actually matters.
const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "br", "div"]);

export function sanitizeReplyHtml(html: string): string {
    return html.replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (match, rawTag: string) => {
        const tag = rawTag.toLowerCase();

        if (!ALLOWED_TAGS.has(tag)) {
            return "";
        }

        if (tag === "br") {
            return "<br>";
        }

        return match.startsWith("</") ? `</${tag}>` : `<${tag}>`;
    });
}

export function htmlToPlainText(sanitizedHtml: string): string {
    // <div> opening tags mark line breaks (each new line in a contentEditable
    // typically becomes its own <div>) - only the opener needs converting,
    // the matching closer is just dropped so adjacent divs don't double up.
    return sanitizedHtml
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<div>/gi, "\n")
        .replace(/<\/div>/gi, "")
        .replace(/<[^>]+>/g, "")
        .trim();
}
