import nodemailer from "nodemailer";
import { db } from "./db.js";
import { SYNC_STALE_MS, syncHealth } from "./systemStatus.js";
export { currentOutages, type Outage } from "./systemStatus.js";
import { overdueJobs, registerJob, runJob } from "./jobHealth.js";
import { storePendingCrash, takeCrashToEmail, type CrashFound } from "./crashLog.js";
import { fetchCodeStatus } from "./codeAlerts.js";
import { CERT_CHECK_EVERY_MS, CERT_WARN_DAYS, DISK_ALERT_RATIO, certDaysLeft, certState, diskUsedRatio } from "./serverChecks.js";

// Step 52: on 2026-10-28 the central sync stopped for 41 hours and the only
// sign was a red line on the status page that nobody watched. Once a minute:
// while a central mailbox has had no successful sync for SYNC_STALE_MS, an
// error line goes to the journal; once per incident the owner gets an email
// (ALERT_EMAIL in .env), and another when syncing works again. Without
// ALERT_EMAIL only the journal line and the status page remain.
//
// Step 53 adds, in the same loop and the same way (one email when it starts,
// one when it ends, a journal line every minute while it lasts):
//   - any background job overdue (jobHealth.ts: hot list, sweep, 5-min check
//     of active students, stale-add check, backup poll);
//   - a crash of the backend, found at the next start (crashLog.ts);
//   - more than CODES_ALERT_ABOVE verification codes expired and still waiting
//     (the status page's "still waiting"), with at most one email pair per
//     CODES_EMAIL_GAP_MS.

const CHECK_EVERY_MS = 60 * 1000;
export const ALERT_ROUND_LIMIT_MS = 60 * 1000;
export const CODES_ALERT_ABOVE = 3;
export const CODES_EMAIL_GAP_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AlertMailer {
    send(fromMailbox: string, subject: string, text: string): Promise<void>;
}


// Mailbox -> when its last successful sync was, while it is stalled.
const stalled = new Map<string, number>();
// Job name -> when its last round completed, while it is overdue.
const jobsDown = new Map<string, number>();
const codes = { alerting: false, lastAboveEmailAt: Number.NEGATIVE_INFINITY };
const server = { certAlerting: false, diskAlerting: false };

const minutes = (ms: number) => Math.round(ms / 60000);

function alertSender(): string {
    return process.env.ACTIVE_CENTRAL_EMAIL || process.env.CENTRAL_EMAIL || syncHealth()[0]?.email || "";
}

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

export async function checkJobs(now = Date.now(), mailer: AlertMailer = smtpMailer): Promise<void> {
    const overdue = new Map(overdueJobs(now).map((job) => [job.name, job]));

    for (const job of overdue.values()) {
        console.error(
            `[alert] JOB STOPPED [${job.name}]: ${job.label} has not completed a round for ${minutes(job.overdueForMs)} min${job.lastError ? ` (last error: ${job.lastError})` : ""}`
        );

        if (!jobsDown.has(job.name)) {
            jobsDown.set(job.name, job.lastOkAt);
            await notify(
                mailer,
                alertSender(),
                `Student Mail: ${job.label} has STOPPED`,
                `${job.label} has not completed a round since ${new Date(job.lastOkAt).toISOString()} (${minutes(job.overdueForMs)} min).\n` +
                    (job.lastError ? `Last error: ${job.lastError}\n` : "") +
                    "Check the status page and the server log."
            );
        }
    }

    for (const [name, since] of [...jobsDown]) {
        if (!overdue.has(name)) {
            jobsDown.delete(name);
            console.log(`[alert] job recovered [${name}] after ${minutes(now - since)} min`);
            await notify(mailer, alertSender(), `Student Mail: ${name} is running again`, `${name} works again (it had stopped for ${minutes(now - since)} min).`);
        }
    }
}

export async function checkCrash(mailer: AlertMailer = smtpMailer): Promise<void> {
    await storePendingCrash();
    const crash: CrashFound | null = takeCrashToEmail();

    if (crash) {
        await notify(
            mailer,
            alertSender(),
            "Student Mail: the backend CRASHED and restarted",
            `The backend crashed at ${new Date(crash.crashedAt).toISOString()} and was back at ${new Date(crash.startedAt).toISOString()} ` +
                `(down ${Math.max(1, Math.round(crash.downMs / 1000))} s).\nCause: ${crash.cause}`
        );
    }
}

export interface WaitingCode {
    at: string;
    details: string;
}

// The status page's "still waiting": expired unused in the last 24 h, no fresh
// code, not registered (codeAlerts.ts, all colleges).
export async function waitingCodes(now = Date.now()): Promise<WaitingCode[]> {
    const status = await fetchCodeStatus();
    return status.recent
        .filter((r) => r.state === "open" && now - new Date(r.at).getTime() < DAY_MS)
        .map((r) => ({ at: r.at, details: r.details }));
}

export async function checkExpiredCodes(
    now = Date.now(),
    mailer: AlertMailer = smtpMailer,
    getWaiting: (now: number) => Promise<WaitingCode[]> = waitingCodes
): Promise<void> {
    const waiting = await getWaiting(now);

    if (waiting.length > CODES_ALERT_ABOVE) {
        if (!codes.alerting && now - codes.lastAboveEmailAt >= CODES_EMAIL_GAP_MS) {
            codes.alerting = true;
            codes.lastAboveEmailAt = now;
            console.error(`[alert] EXPIRED CODES: ${waiting.length} verification codes expired and are still waiting`);
            await notify(
                mailer,
                alertSender(),
                `Student Mail: ${waiting.length} expired codes still waiting`,
                `${waiting.length} verification codes expired unused and have no fresh code yet:\n\n` +
                    waiting.map((w) => `- expired ${w.at}: ${w.details}`).join("\n")
            );
        }
    } else if (codes.alerting) {
        codes.alerting = false;
        console.log(`[alert] expired codes back to ${waiting.length}`);
        await notify(
            mailer,
            alertSender(),
            `Student Mail: expired codes back to ${waiting.length}`,
            `Expired codes still waiting are back to ${waiting.length} (alert above ${CODES_ALERT_ABOVE}).`
        );
    }
}

// HTTPS certificate: checked hourly; an email once when fewer than
// CERT_WARN_DAYS are left, once when renewed. A failed check (network) is
// logged and never alerts.
export async function checkCert(
    now = Date.now(),
    mailer: AlertMailer = smtpMailer,
    getDaysLeft: () => Promise<number> = () => certDaysLeft()
): Promise<void> {
    if (now - certState.checkedAt < CERT_CHECK_EVERY_MS) {
        return;
    }

    certState.checkedAt = now;

    try {
        certState.daysLeft = await getDaysLeft();
        certState.error = null;
    } catch (error) {
        certState.error = error instanceof Error ? error.message : String(error);
        console.error("[alert] certificate check failed:", certState.error);
        return;
    }

    const days = Math.floor(certState.daysLeft);

    if (certState.daysLeft < CERT_WARN_DAYS) {
        console.error(`[alert] HTTPS CERTIFICATE expires in ${days} days`);

        if (!server.certAlerting) {
            server.certAlerting = true;
            await notify(
                mailer,
                alertSender(),
                `Student Mail: HTTPS certificate expires in ${days} days`,
                `The certificate of the console expires in ${days} days and has not been renewed yet. When it expires the site stops working.
` +
                    "Check on the server: sudo certbot renew --dry-run; systemctl status certbot.timer"
            );
        }
    } else if (server.certAlerting) {
        server.certAlerting = false;
        await notify(mailer, alertSender(), "Student Mail: HTTPS certificate renewed", `The certificate is valid for ${days} more days.`);
    }
}

export async function checkDisk(mailer: AlertMailer = smtpMailer, getRatio: () => number = () => diskUsedRatio()): Promise<void> {
    const ratio = getRatio();
    const used = Math.round(ratio * 100);

    if (ratio > DISK_ALERT_RATIO) {
        console.error(`[alert] DISK ${used}% full`);

        if (!server.diskAlerting) {
            server.diskAlerting = true;
            await notify(mailer, alertSender(), `Student Mail: server disk ${used}% full`, `The server disk is ${used}% full. When it is full, the database and the console stop.`);
        }
    } else if (server.diskAlerting) {
        server.diskAlerting = false;
        await notify(mailer, alertSender(), `Student Mail: server disk back to ${used}%`, `The server disk is ${used}% full again.`);
    }
}

// One round of every check; one failing never stops the others.
export async function checkAll(now = Date.now(), mailer: AlertMailer = smtpMailer): Promise<void> {
    const steps: [string, () => Promise<void>][] = [
        ["sync", () => checkSyncStall(now, mailer)],
        ["jobs", () => checkJobs(now, mailer)],
        ["crash", () => checkCrash(mailer)],
        ["codes", () => checkExpiredCodes(now, mailer)],
        ["cert", () => checkCert(now, mailer)],
        ["disk", () => checkDisk(mailer)],
    ];

    for (const [name, step] of steps) {
        try {
            await step();
        } catch (error) {
            console.error(`[alert] ${name} check failed:`, error instanceof Error ? error.message : error);
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

        if (!to || !fromMailbox) {
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
    // Step 53: the alert loop is a job like the others - bounded, and overdue
    // shows on the status page (it cannot email about itself).
    registerJob("alerts", "Alert check", 10 * 60 * 1000);
    setInterval(() => {
        void runJob("alerts", () => checkAll(), ALERT_ROUND_LIMIT_MS);
    }, CHECK_EVERY_MS).unref?.();
}

// Tests only.
export function resetAlerts(): void {
    stalled.clear();
    jobsDown.clear();
    codes.alerting = false;
    codes.lastAboveEmailAt = Number.NEGATIVE_INFINITY;
    server.certAlerting = false;
    server.diskAlerting = false;
    certState.daysLeft = null;
    certState.checkedAt = 0;
    certState.error = null;
}
