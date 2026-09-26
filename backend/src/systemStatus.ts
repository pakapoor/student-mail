import { statfsSync } from "node:fs";
import os from "node:os";
import { db } from "./db.js";

// System status page (Step 21, /status - user: "status page is fine", no
// alert emails). The background jobs report into this module; the page
// reads a snapshot. Events live in memory for 24 h (a restart clears them;
// Migadu delays come from the database, so they survive restarts).

type EventKind = "retry" | "gave-up" | "mailbox-failed" | "recovered" | "sync-failed";

interface StatusEvent {
    at: number;
    kind: EventKind;
    source?: string;
    detail: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 500;
const events: StatusEvent[] = [];
const startedAt = Date.now();

const sync = new Map<string, { connected: boolean; changedAt: number; lastSuccessAt: number | null }>();

function prune() {
    const cutoff = Date.now() - DAY_MS;

    while (events.length > 0 && (events[0]!.at < cutoff || events.length > MAX_EVENTS)) {
        events.shift();
    }
}

export function noteEvent(kind: EventKind, detail: string, source?: string): void {
    events.push({ at: Date.now(), kind, detail, ...(source ? { source } : {}) });
    prune();
}

export function noteWatcher(mailbox: string, connected: boolean): void {
    const current = sync.get(mailbox);
    sync.set(mailbox, {
        connected,
        changedAt: current?.connected === connected ? current.changedAt : Date.now(),
        lastSuccessAt: current?.lastSuccessAt ?? null,
    });
}

export function noteSyncSuccess(mailbox: string): void {
    const current = sync.get(mailbox);
    sync.set(mailbox, {
        connected: current?.connected ?? false,
        changedAt: current?.changedAt ?? Date.now(),
        lastSuccessAt: Date.now(),
    });
}

// Hot-list and sweep figures are supplied by those modules (avoids import
// cycles): each registers a function returning its current numbers.
type Provider = () => Promise<Record<string, unknown>> | Record<string, unknown>;
const providers = new Map<string, Provider>();

export function registerStatusProvider(name: string, provider: Provider): void {
    providers.set(name, provider);
}

// A sync that hasn't succeeded for this long means new mail isn't reaching
// the console.
const SYNC_STALE_MS = 10 * 60 * 1000;
const DISK_PROBLEM_RATIO = 0.9;

function since(kind: EventKind, source?: string): StatusEvent[] {
    const cutoff = Date.now() - DAY_MS;
    return events.filter((e) => e.at >= cutoff && e.kind === kind && (source === undefined || e.source === source));
}

export async function getSystemStatus() {
    prune();
    const now = Date.now();
    const problems: string[] = [];
    const warnings: string[] = [];

    // --- Central sync -------------------------------------------------------
    const mailboxes = [...sync.entries()].map(([email, s]) => ({
        email,
        connected: s.connected,
        lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
    }));

    for (const [email, s] of sync) {
        const lastOk = s.lastSuccessAt ?? startedAt;

        if (now - lastOk > SYNC_STALE_MS) {
            problems.push(`No successful sync of ${email} for ${Math.round((now - lastOk) / 60000)} min - new emails are not reaching the console.`);
        } else if (!s.connected && now - s.changedAt > 2 * 60 * 1000) {
            warnings.push(`Live connection to ${email} is down (reconnecting); a backup poll still syncs.`);
        }
    }

    if (sync.size === 0) {
        problems.push("No central mailbox sync is running.");
    }

    // --- Database -------------------------------------------------------------
    let database: Record<string, unknown> = { reachable: false };
    let emailsToday = 0;
    let delays: Record<string, unknown> = {};
    let recentDelays: { at: string; minutes: number; queue: string | null; from: string; student: string }[] = [];

    try {
        const counts = await db.query<{ total: string; today: string }>(
            `SELECT count(*) AS total,
                    count(*) FILTER (WHERE received_at >= date_trunc('day', now())) AS today
             FROM messages`
        );
        emailsToday = Number(counts.rows[0]?.today ?? 0);
        database = { reachable: true, emails: Number(counts.rows[0]?.total ?? 0) };

        const d = await db.query<{ today_count: string; today_max: number | null; week_max: number | null }>(
            `SELECT count(*) FILTER (WHERE received_at >= date_trunc('day', now()) AND migadu_hold_seconds > 300) AS today_count,
                    max(migadu_hold_seconds) FILTER (WHERE received_at >= date_trunc('day', now())) AS today_max,
                    max(migadu_hold_seconds) FILTER (WHERE received_at >= now() - interval '7 days') AS week_max
             FROM messages`
        );
        const row = d.rows[0];
        delays = {
            heldOver5MinToday: Number(row?.today_count ?? 0),
            longestTodaySeconds: row?.today_max ?? null,
            longest7DaysSeconds: row?.week_max ?? null,
        };

        const r = await db.query<{ received_at: string; migadu_hold_seconds: number; migadu_queue_id: string | null; sender_email: string; student_email: string }>(
            `SELECT received_at, migadu_hold_seconds, migadu_queue_id, sender_email, student_email
             FROM messages
             WHERE migadu_hold_seconds > 300 AND received_at >= now() - interval '24 hours'
             ORDER BY received_at DESC LIMIT 20`
        );
        recentDelays = r.rows.map((x) => ({
            at: new Date(x.received_at).toISOString(),
            minutes: Math.round(x.migadu_hold_seconds / 60),
            queue: x.migadu_queue_id,
            from: x.sender_email,
            student: x.student_email,
        }));

        if (Number(row?.today_count ?? 0) > 0) {
            warnings.push(`Migadu held ${row?.today_count} email(s) for more than 5 min today.`);
        }
    } catch (error) {
        problems.push(`Database not reachable: ${error instanceof Error ? error.message : String(error)}`);
    }

    // --- Server ---------------------------------------------------------------
    let disk: Record<string, number> | null = null;

    try {
        const fsStat = statfsSync("/");
        const total = fsStat.blocks * fsStat.bsize;
        const free = fsStat.bavail * fsStat.bsize;
        disk = { totalBytes: total, usedBytes: total - free };

        if ((total - free) / total > DISK_PROBLEM_RATIO) {
            problems.push(`Disk almost full: ${Math.round(((total - free) / total) * 100)}% used.`);
        }
    } catch {
        // Not critical for the page.
    }

    const server = {
        disk,
        memory: { totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem() },
        appStartedAt: new Date(startedAt).toISOString(),
    };

    // --- Retries / give-ups ---------------------------------------------------
    const retries = since("retry").length;
    const gaveUp = since("gave-up");

    if (gaveUp.length > 0) {
        warnings.push(`${gaveUp.length} email(s) in retained activity could not be fetched after 5 tries (search the student to recover).`);
    }

    // --- Providers (hot list, sweep) -----------------------------------------
    const extra: Record<string, unknown> = {};

    for (const [name, provider] of providers) {
        try {
            extra[name] = await provider();
        } catch (error) {
            extra[name] = { error: error instanceof Error ? error.message : String(error) };
        }
    }

    // --- Recent problems list -------------------------------------------------
    const recent = [
        ...recentDelays.map((d) => ({
            at: d.at,
            what: "Migadu delay",
            details: `Held ${d.minutes} min · queue ${d.queue ?? "unknown"} · ${d.from} → ${d.student}`,
        })),
        ...events
            .filter((e) => e.kind === "mailbox-failed" || e.kind === "gave-up" || e.kind === "sync-failed")
            .map((e) => ({
                at: new Date(e.at).toISOString(),
                what:
                    e.kind === "mailbox-failed"
                        ? "Mailbox won't open"
                        : e.kind === "gave-up"
                          ? "Email could not be fetched"
                          : "Central sync failed",
                details: e.detail,
            })),
    ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 50);

    return {
        generatedAt: new Date(now).toISOString(),
        activityCoverage: {
            // Once the cap is hit, older events were dropped - coverage then
            // starts at the oldest one still kept, not 24 h ago.
            since: new Date(
                Math.max(startedAt, now - DAY_MS, events.length >= MAX_EVENTS ? events[0]!.at : 0)
            ).toISOString(),
            maxEvents: MAX_EVENTS,
            retainedEvents: events.length,
            approximate: true,
        },
        overall: problems.length > 0 ? "problem" : warnings.length > 0 ? "warning" : "ok",
        problems,
        warnings,
        sync: { mailboxes, emailsToday },
        retries: { retriedToday: retries, gaveUpToday: gaveUp.length },
        recoveredToday: {
            search: since("recovered", "check-mail").length,
            sweep: since("recovered", "sweep").length,
            hot: since("recovered", "hot").length,
        },
        mailboxFailures24h: since("mailbox-failed").length,
        delays,
        database,
        server,
        ...extra,
        recent,
    };
}
