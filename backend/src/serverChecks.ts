import { readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";

// Step 53 (owner: "3 nines"): the measured uptime, the HTTPS certificate and the
// disk - things that can take the whole site down on a single server.

// --- Uptime -------------------------------------------------------------------
// The server's health check (deploy/systemd/student-mail-health.sh) appends
// "<unix time> ok|stalled|down" every minute. console up = the backend answered
// (ok or stalled); mail flowing = ok.

export interface Uptime {
    since: string | null;
    measuredMinutes: number;
    consoleUpPct: number | null;
    mailFlowingPct: number | null;
    downMinutes: number;
    stalledMinutes: number;
}

export function healthLogFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.resolve(env.RUN_STATE_DIR || path.join(process.cwd(), ".run"), "health.log");
}

const pct = (part: number, whole: number) => (whole === 0 ? null : Math.floor((part / whole) * 100000) / 1000);

// Pure: the figures over the last `days` from the log's text.
export function summarizeHealthLog(text: string, now: number, days = 30): Uptime {
    const from = Math.floor(now / 1000) - days * 24 * 60 * 60;
    let ok = 0;
    let stalled = 0;
    let down = 0;
    let first: number | null = null;

    for (const line of text.split("\n")) {
        const [t, result] = line.trim().split(/\s+/);
        const at = Number(t);

        if (!Number.isFinite(at) || at < from || at > now / 1000 + 60) {
            continue;
        }

        if (result === "ok") ok++;
        else if (result === "stalled") stalled++;
        else if (result === "down") down++;
        else continue;

        first = first === null ? at : Math.min(first, at);
    }

    const total = ok + stalled + down;

    return {
        since: first === null ? null : new Date(first * 1000).toISOString(),
        measuredMinutes: total,
        consoleUpPct: pct(ok + stalled, total),
        mailFlowingPct: pct(ok, total),
        downMinutes: down,
        stalledMinutes: stalled,
    };
}

export function readUptime(now = Date.now(), file = healthLogFile()): Uptime {
    let text = "";

    try {
        text = readFileSync(file, "utf8");
    } catch {
        // No log yet (dev machine, or the timer not installed).
    }

    return summarizeHealthLog(text, now);
}

// --- HTTPS certificate --------------------------------------------------------
// Certbot renews it automatically; if renewal ever fails, the whole site goes
// down when it expires. Read off a real TLS connection to our own site (the
// backend cannot read /etc/letsencrypt).

export const CERT_WARN_DAYS = 14;
export const CERT_CHECK_EVERY_MS = 60 * 60 * 1000;

export function certHost(env: NodeJS.ProcessEnv = process.env): string {
    return env.CERT_HOST || "app.myemailinfo.com";
}

export function certDaysLeft(host = certHost(), port = 443, timeoutMs = 10000): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
            const cert = socket.getPeerCertificate();
            socket.end();

            if (!cert?.valid_to) {
                reject(new Error("no certificate"));
                return;
            }

            resolve((new Date(cert.valid_to).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        });
        socket.on("timeout", () => {
            socket.destroy();
            reject(new Error(`no TLS answer from ${host} within ${timeoutMs} ms`));
        });
        socket.on("error", reject);
    });
}

// Last known result, shared by the alert loop (which checks hourly) and the
// status page.
export const certState: { daysLeft: number | null; checkedAt: number; error: string | null } = {
    daysLeft: null,
    checkedAt: 0,
    error: null,
};

// --- Disk ---------------------------------------------------------------------
export const DISK_ALERT_RATIO = 0.9;

export function diskUsedRatio(mount = "/"): number {
    const s = statfsSync(mount);
    const total = s.blocks * s.bsize;
    return total === 0 ? 0 : (total - s.bavail * s.bsize) / total;
}
