import type { IncomingThreadItem, ThreadItem } from "./types";

// Pulls the one thing staff open these threads for - a verification code,
// login credentials, or a document rejection - out of emails whose exact
// layout we know, so ThreadView can show it above the email.
//
// Only fully known templates count. Checked against every Edugate email in
// production on 2026-09-25: 579/579 matched (292 code, 287 login; English and
// Russian), 0 ambiguous, every login email equal to the thread's student. If a
// sender changes even one word of its template, nothing matches and the
// thread simply looks as it did before - never a guessed value.

export type KeyInfo =
    | { kind: "code"; code: string; validMinutes: number; item: IncomingThreadItem }
    | { kind: "login"; login: string; password: string; item: IncomingThreadItem }
    // note = the reviewer's text, whole. noteKind "action" when it contains an
    // instruction ("Please …" / "Upload …"), else "reason". note is null when
    // the reviewer wrote no actual words (e.g. just "1").
    | {
          kind: "rejected";
          document: string;
          note: string | null;
          noteKind: "action" | "reason";
          reviewedAt: string;
          item: IncomingThreadItem;
      };

interface Template {
    sender: string;
    match: (text: string, item: IncomingThreadItem) => KeyInfo | null;
}

// Edugate (confirm@edu.gov.kg), the KR ministry admission portal. Each email
// comes in English or Russian with identical structure.
const EDUGATE_CODE =
    /(?:^|\n)(?:Your verification code:|Ваш код подтверждения:)\n\n(\d{6})\n\n(?:Enter this code\. The code is valid for (\d{1,3}) minutes\.|Введите этот код\. Код действителен в течение (\d{1,3}) минут\.)(?:\n|$)/g;
const EDUGATE_LOGIN =
    /(?:^|\n)(?:Login \(Email\):|Логин \(Email\):)\n([^\s@]+@[^\s@]+\.[^\s@]+) (?:Password:|Пароль:)\n(\S{6,64})\n\n/g;

// Edugate document review (notify@edu.gov.kg): a Russian half, a dashed
// separator, then an English half - only the English half is used (staff
// read English). Checked 2026-09-25 against all 38 such emails in
// production: all "Document rejected", 38/38 matched, every English reason
// in English. The document name can wrap over several lines; the reason is
// the free text the reviewer typed (translated by Edugate).
const EDUGATE_REJECTED =
    /\n-{20,}\n\nHello, [^\n!]+!\n\n+❌ DOCUMENT REJECTED\n\nDocument: ([\s\S]+?)\n\n([\s\S]+?)\n\nReviewed by: [^\n]+, (\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})\n/g;
// Some notes end with Edugate's WhatsApp contact sentence - left out of the
// box (the user's choice); it stays visible in the email itself. Matched
// after joining lines (the stored text wraps it), wherever it appears - it
// can be followed by more text, e.g. "Thank you for your cooperation!".
const EDUGATE_WHATSAPP = / ?If you have any questions, please contact us via WhatsApp at: ?\+?[\d ()-]+\d\.?/g;
// A sentence that tells the student what to do.
const INSTRUCTION = /(?:^|[.!?] )(?:Please|Upload)\b/;

function oneLine(text: string): string {
    return text.split(/\s+/).join(" ").trim();
}

const TEMPLATES: Template[] = [
    {
        sender: "confirm@edu.gov.kg",
        match(text, item) {
            const codes = [...text.matchAll(EDUGATE_CODE)];
            const logins = [...text.matchAll(EDUGATE_LOGIN)];

            // Exactly one of the two, exactly once - anything else is a
            // layout we haven't verified.
            if (codes.length === 1 && logins.length === 0) {
                const [, code, en, ru] = codes[0]!;
                return { kind: "code", code: code!, validMinutes: Number(en ?? ru), item };
            }

            if (logins.length === 1 && codes.length === 0) {
                const [, login, password] = logins[0]!;

                // Extra certainty: the credentials must be for this thread's
                // own student (true for all 287 real login emails).
                if (login!.toLowerCase() !== item.student_email.toLowerCase()) {
                    return null;
                }

                return { kind: "login", login: login!, password: password!, item };
            }

            return null;
        },
    },
    {
        sender: "notify@edu.gov.kg",
        match(text, item) {
            const rejections = [...text.matchAll(EDUGATE_REJECTED)];

            if (rejections.length !== 1) {
                return null;
            }

            const [, documentText, noteText, reviewedAt] = rejections[0]!;
            const note = oneLine(noteText!).replace(EDUGATE_WHATSAPP, "").trim();

            return {
                kind: "rejected",
                document: oneLine(documentText!),
                // No letters at all (a placeholder like "1") → no note line.
                note: /\p{L}/u.test(note) ? note : null,
                noteKind: INSTRUCTION.test(note) ? "action" : "reason",
                reviewedAt: reviewedAt!,
                item,
            };
        },
    },
];

// The newest incoming email in the thread that matches a known template, or
// null. Older matches are ignored on purpose - an older code is almost
// certainly expired.
export function findKeyInfo(items: ThreadItem[]): KeyInfo | null {
    try {
        const incoming = items
            .filter((item): item is IncomingThreadItem => item.type === "incoming")
            .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

        for (const item of incoming) {
            const template = TEMPLATES.find((t) => t.sender === item.sender_email.toLowerCase());

            if (!template || !item.body_text) {
                continue;
            }

            const found = template.match(item.body_text.replace(/\r\n/g, "\n"), item);

            if (found) {
                return found;
            }
        }
    } catch {
        // Never let detection break opening a thread - just no box.
    }

    return null;
}
