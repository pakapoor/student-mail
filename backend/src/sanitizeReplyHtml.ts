// Composer output only ever needs Bold/Italic/Underline/lists/line breaks
// (Step 13's scope), so this is a narrow allowlist, not a general HTML
// sanitizer: every tag not in ALLOWED_TAGS is stripped (including all
// attributes on tags that ARE allowed - e.g. onmouseover="..." on a <b> is
// dropped, not just ignored). This is the actual trust boundary - a request
// can reach this endpoint without going through the browser's
// contentEditable serialization at all, so sanitizing here (not just in the
// frontend) is what actually matters.
const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "br", "div", "ul", "ol", "li"]);

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

// Regex alone can't track <ol> item numbering (needs a counter that resets
// per list and increments per <li>), so this walks tags in order with a
// small stack instead of one blanket replace per tag.
export function htmlToPlainText(sanitizedHtml: string): string {
    const listStack: { type: "ul" | "ol"; counter: number }[] = [];
    let result = "";

    for (const token of sanitizedHtml.split(/(<[^>]+>)/g)) {
        if (!token) {
            continue;
        }

        const tagMatch = token.match(/^<\/?([a-zA-Z0-9]+)/);

        if (!tagMatch) {
            result += token;
            continue;
        }

        const tag = (tagMatch[1] ?? "").toLowerCase();
        const isClosing = token.startsWith("</");

        if (tag === "br") {
            result += "\n";
        } else if (tag === "div") {
            if (!isClosing) {
                result += "\n";
            }
        } else if (tag === "ul" || tag === "ol") {
            if (!isClosing) {
                result += "\n";
                listStack.push({ type: tag, counter: 0 });
            } else {
                listStack.pop();
            }
        } else if (tag === "li") {
            if (!isClosing) {
                const list = listStack[listStack.length - 1];
                if (list?.type === "ol") {
                    list.counter += 1;
                    result += `${list.counter}. `;
                } else {
                    result += "- ";
                }
            } else {
                result += "\n";
            }
        }
        // Other allowed tags (b/strong/i/em/u) carry no plain-text effect.
    }

    // Collapse any blank lines produced by adjacent block boundaries (e.g. a
    // list ending right where a new div starts) rather than special-casing
    // every possible tag transition.
    return result.replace(/\n{2,}/g, "\n").trim();
}
