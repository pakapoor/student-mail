import nodemailer from "nodemailer";
import { db } from "./db.js";
import { SYNC_STALE_MS, syncHealth } from "./systemStatus.js";

// Step 52: on 2026-10-28 the central sync stopped for 41 hours and the only
// sign was a red line on the status page that nobody watched. Once a minute:
// while a central mailbox has had no successful sync for SYNC_STALE_MS, an
// error line goes to the journal; once per incident the owner gets an email
// (ALERT_EMAIL in .env), and another when syncing works again. Without
// ALERT_EMAIL only the journal line and the status page remain.

const CHECK_EVERY_MS = 60 * 1000;

export interface AlertMailer {
    send(fromMailbox: string, subject: string, text: string): Promise<void>;
}

// Mailbox -> when its last successful sync was, while it is stalled.
const stalled = new Map<string, number>();

const minutes = (ms: number) => Math.round(ms / 60000);

export async function checkSyncStall(now = Date.now(), mailer: AlertMailer = smtpMailer): Promise<void> {
    for (const { email, lastOkAt } of syncHealth()) {
        const staleMs = now - lastOkAt;

        if (staleMs > SYNC_STALE_MS) {
            console.error(
                `[alert] SYNC STALLED [${email}]: no successful central sync for ${minutes(staleMs)} min - new emails are not reaching the console`
            );

            if (!stalled.has(email)) {
                stalled.set(email, lastOkAt);
                await notify(
                    mailer,
                    email,
                    "Student Mail: emails are NOT reaching the console",
                    `No successful sync of ${email} since ${new Date(lastOkAt).toISOString()} (${minutes(staleMs)} min).\n` +
                        "New emails (codes, logins, rejections) are not showing in the console.\n" +
                        "Check the status page and the server log; a backend restart clears a stuck sync."
                );
            }
        } else if (stalled.has(email)) {
            const since = stalled.get(email)!;
            stalled.delete(email);
            console.log(`[alert] sync recovered [${email}] after ${minutes(now - since)} min`);
            await notify(
                mailer,
                email,
                "Student Mail: emails are reaching the console again",
                `Syncing of ${email} works again (it had stopped for ${minutes(now - since)} min).`
            );
        }
    }
}

// Never throws: a failed alert email is logged, the journal line still stands.
async function notify(mailer: AlertMailer, fromMailbox: string, subject: string, text: string): Promise<void> {
    try {
        await mailer.send(fromMailbox, subject, text);
    } catch (error) {
        console.error("[alert] could not send the alert email:", error instanceof Error ? error.message : error);
    }
}

// Sent from the central mailbox itself (SMTP, its stored password), like the
// TEST email of Add students.
const smtpMailer: AlertMailer = {
    async send(fromMailbox, subject, text) {
        const to = process.env.ALERT_EMAIL;

        if (!to) {
            return;
        }

        const central = await db.query<{ password: string }>("SELECT password FROM central_mailboxes WHERE email = $1", [fromMailbox]);
        const password = central.rows[0]?.password;

        if (!password) {
            throw new Error(`no password stored for the central mailbox ${fromMailbox}`);
        }

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 465),
            secure: process.env.SMTP_SECURE !== "false",
            auth: { user: fromMailbox, pass: password },
            connectionTimeout: 10000,
            socketTimeout: 10000,
        });

        await transporter.sendMail({ from: fromMailbox, to, subject, text });
    },
};

export function startSyncAlert(): void {
    let running = false;

    setInterval(() => {
        if (running) {
            return;
        }

        running = true;
        checkSyncStall()
            .catch((error) => console.error("[alert] stall check failed:", error))
            .finally(() => {
                running = false;
            });
    }, CHECK_EVERY_MS).unref?.();
}
