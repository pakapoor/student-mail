// Edugate email templates - the single source of truth, used by BOTH the
// frontend (the code / login / rejection box above a thread, keyInfo.ts) and
// the backend (messages.edugate_kind and students.registration_status).
// Keeping one copy means the box and the status can never disagree.
//
// Edugate is the KR ministry admission portal; all 3 colleges use it.
// Only fully known templates count. Verified against every Edugate email in
// production on 2026-09-25:
//   - confirm@edu.gov.kg: 579/579 matched - 292 verification-code emails,
//     287 registration (login + password) emails, English and Russian, 0
//     ambiguous, every login email equal to the email's own student.
//   - notify@edu.gov.kg: 38/38 matched - all "Document rejected".
// If a sender changes even one word of a template, nothing matches (null):
// the box doesn't appear and the status doesn't change - never a guess.
//
// Pure functions only (no DOM, no Node APIs) so both sides can import it.

export type EdugateKind = "code" | "login" | "rejected";

export type EdugateInfo =
    | { kind: "code"; code: string; validMinutes: number }
    | { kind: "login"; login: string; password: string }
    // note = the reviewer's text, whole. noteKind "action" when it contains
    // an instruction ("Please …" / "Upload …"), else "reason". note is null
    // when the reviewer wrote no actual words (e.g. just "1").
    | { kind: "rejected"; document: string; note: string | null; noteKind: "action" | "reason"; reviewedAt: string };

export const EDUGATE_SENDERS = ["confirm@edu.gov.kg", "notify@edu.gov.kg"];

// Where staff log in to re-upload documents etc. The emails themselves carry
// no link; the portal ("Цифровые ворота" = Digital Gate, on the education
// ministry's ilim.gov.kg domain) was confirmed by the user logging in with a
// student's credentials on 2026-09-26. Change it here if Edugate moves.
export const EDUGATE_LOGIN_URL = "https://edugate.ilim.gov.kg/edugate/login";

const CODE =
    /(?:^|\n)(?:Your verification code:|Ваш код подтверждения:)\n\n(\d{6})\n\n(?:Enter this code\. The code is valid for (\d{1,3}) minutes\.|Введите этот код\. Код действителен в течение (\d{1,3}) минут\.)(?:\n|$)/g;
const LOGIN =
    /(?:^|\n)(?:Login \(Email\):|Логин \(Email\):)\n([^\s@]+@[^\s@]+\.[^\s@]+) (?:Password:|Пароль:)\n(\S{6,64})\n\n/g;

// Document review (notify@): a Russian half, a dashed separator, then an
// English half - only the English half is used (staff read English). The
// document name can wrap over several lines; the note is the free text the
// reviewer typed (translated by Edugate).
const REJECTED =
    /\n-{20,}\n\nHello, [^\n!]+!\n\n+❌ DOCUMENT REJECTED\n\nDocument: ([\s\S]+?)\n\n([\s\S]+?)\n\nReviewed by: [^\n]+, (\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})\n/g;
// Some notes contain Edugate's WhatsApp contact sentence - left out of the
// box (the user's choice); it stays visible in the email itself. Matched
// after joining lines (the stored text wraps it), wherever it appears - it
// can be followed by more text, e.g. "Thank you for your cooperation!".
const WHATSAPP = / ?If you have any questions, please contact us via WhatsApp at: ?\+?[\d ()-]+\d\.?/g;
// A sentence that tells the student what to do.
const INSTRUCTION = /(?:^|[.!?] )(?:Please|Upload)\b/;

function oneLine(text: string): string {
    return text.split(/\s+/).join(" ").trim();
}

function classifyConfirm(text: string, studentEmail: string): EdugateInfo | null {
    const codes = [...text.matchAll(CODE)];
    const logins = [...text.matchAll(LOGIN)];

    // Exactly one of the two, exactly once - anything else is a layout we
    // haven't verified.
    if (codes.length === 1 && logins.length === 0) {
        const [, code, en, ru] = codes[0]!;
        return { kind: "code", code: code!, validMinutes: Number(en ?? ru) };
    }

    if (logins.length === 1 && codes.length === 0) {
        const [, login, password] = logins[0]!;

        // Extra certainty: the credentials must be for this email's own
        // student (true for all 287 real login emails).
        if (login!.toLowerCase() !== studentEmail.toLowerCase()) {
            return null;
        }

        return { kind: "login", login: login!, password: password! };
    }

    return null;
}

function classifyNotify(text: string): EdugateInfo | null {
    const rejections = [...text.matchAll(REJECTED)];

    if (rejections.length !== 1) {
        return null;
    }

    const [, documentText, noteText, reviewedAt] = rejections[0]!;
    const note = oneLine(noteText!).replace(WHATSAPP, "").trim();

    return {
        kind: "rejected",
        document: oneLine(documentText!),
        // No letters at all (a placeholder like "1") → no note line.
        note: /\p{L}/u.test(note) ? note : null,
        noteKind: INSTRUCTION.test(note) ? "action" : "reason",
        reviewedAt: reviewedAt!,
    };
}

export function isEdugateSender(senderEmail: string): boolean {
    return EDUGATE_SENDERS.includes(senderEmail.toLowerCase());
}

// What a single email is, if it's a known Edugate template; null otherwise
// (including any Edugate email whose layout we haven't verified). Never
// throws.
export function classifyEdugate(
    senderEmail: string,
    bodyText: string | null | undefined,
    studentEmail: string
): EdugateInfo | null {
    try {
        if (!bodyText) {
            return null;
        }

        const text = bodyText.replace(/\r\n/g, "\n");
        const sender = senderEmail.toLowerCase();

        if (sender === "confirm@edu.gov.kg") {
            return classifyConfirm(text, studentEmail);
        }

        if (sender === "notify@edu.gov.kg") {
            return classifyNotify(text);
        }
    } catch {
        // Detection must never break storing or showing an email.
    }

    return null;
}
