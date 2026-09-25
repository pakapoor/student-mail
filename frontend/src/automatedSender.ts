import { isEdugateSender } from "../../shared/edugate";

// Senders whose mailbox nobody reads - replying to them goes nowhere, so the
// thread shows no reply box (Step 18, user). Covers both Edugate senders
// (confirm@ codes/logins, notify@ rejections - ~9 in 10 emails in the
// console; the emails themselves say "do not reply") and the usual
// automated address names on any domain.
const AUTOMATED_LOCAL_PART =
    /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notify|notifications?|mailer[-_.]?daemon|postmaster|bounces?)$/i;

export function isAutomatedSender(email: string | null | undefined): boolean {
    if (!email) {
        return false;
    }

    const address = email.trim().toLowerCase();
    return isEdugateSender(address) || AUTOMATED_LOCAL_PART.test(address.split("@")[0] ?? "");
}
