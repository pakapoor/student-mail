import type { IncomingThreadItem, ThreadItem } from "./types";
import { classifyEdugate, type EdugateInfo } from "../../shared/edugate";

// Pulls the one thing staff open these threads for - a verification code,
// login credentials, or a document rejection - out of emails whose exact
// layout we know, so ThreadView can show it above the email. The templates
// themselves live in shared/edugate.ts (also used by the backend for the
// students' registration status), so the box and the status always agree.

export type KeyInfo = EdugateInfo & { item: IncomingThreadItem };

// The newest incoming email in the thread that matches a known template, or
// null. Older matches are ignored on purpose - an older code is almost
// certainly expired.
export function findKeyInfo(items: ThreadItem[]): KeyInfo | null {
    try {
        const incoming = items
            .filter((item): item is IncomingThreadItem => item.type === "incoming")
            .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

        for (const item of incoming) {
            const found = classifyEdugate(item.sender_email, item.body_text, item.student_email);

            if (found) {
                return { ...found, item };
            }
        }
    } catch {
        // Never let detection break opening a thread - just no box.
    }

    return null;
}
