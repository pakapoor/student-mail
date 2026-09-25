import type { IncomingThreadItem, ThreadItem } from "./types";

// Pulls the one thing staff open these threads for - a verification code or
// login credentials - out of emails whose exact layout we know, so ThreadView
// can show it (with Copy buttons) above the email.
//
// Only fully known templates count. Checked against every Edugate email in
// production on 2026-09-25: 579/579 matched (292 code, 287 login; English and
// Russian), 0 ambiguous, every login email equal to the thread's student. If a
// sender changes even one word of its template, nothing matches and the
// thread simply looks as it did before - never a guessed value.

export type KeyInfo =
    | { kind: "code"; code: string; validMinutes: number; item: IncomingThreadItem }
    | { kind: "login"; login: string; password: string; item: IncomingThreadItem };

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
