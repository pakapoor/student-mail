import { statfsSync } from "node:fs";
import os from "node:os";
import { db } from "./db.js";
import { fetchCodeStatus, type CodeStatus } from "./codeAlerts.js";

// System status page (Step 21, /status - user: "status page is fine", no
// alert emails). The background jobs report into this module; the page
// reads a snapshot. Events live in memory for 24 h and only feed the counts
// (a restart clears them). The "Recent problems" list comes from the
// database, so it survives restarts: problems are stored in status_problems
// (Step 28) and Migadu delays are read off messages.

type EventKind = "retry" | "gave-up" | "mailbox-failed" | "recovered" | "sync-failed";
type ProblemKind = "gave-up" | "mailbox-failed" | "sync-failed";

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

// A problem worth listing until it's solved: counted in memory like any
// event, and stored so it survives restarts. `subject` is what a later
// solveProblems() call matches on; while it's still open, a repeat (the hot
// list re-failing every few minutes) bumps the same row instead of adding
// one. Never throws - a status write must not break the sync or mailbox
// check that reported it.
export function noteProblem(kind: ProblemKind, subject: string, detail: string, source?: string): void {
    noteEvent(kind, detail, source);
    db.query(
        `INSERT INTO status_problems (kind, subject, source, detail) VALUES ($1, $2, $3, $4)
         ON CONFLICT (kind, subject) WHERE solved_at IS NULL
         DO UPDATE SET times = status_problems.times + 1, last_at = NOW(), detail = EXCLUDED.detail, source = EXCLUDED.source`,
        [kind, subject, source ?? null, detail]
    ).catch((error) => console.error("[status] could not store problem:", error));
}

// The thing works again (mailbox opened, email stored, sync succeeded):
// mark its open problems solved. Usually matches nothing - the partial index
// on open problems keeps that a cheap lookup.
export function solveProblems(kind: ProblemKind, subject: string): void {
    db.query("UPDATE status_problems SET solved_at = NOW() WHERE kind = $1 AND subject = $2 AND solved_at IS NULL", [
        kind,
        subject,
    ]).catch((error) => console.error("[status] could not mark problem solved:", error));
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
    solveProblems("sync-failed", mailbox);
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
// "Recent problems": the newest RECENT_LIMIT rows, open ones first. Solved
// problems are kept (greyed) for a week, everything is gone after 30 days.
const RECENT_LIMIT = 100;
const SOLVED_KEEP_DAYS = 7;
const PROBLEM_KEEP_DAYS = 30;

const PROBLEM_LABELS: Record<ProblemKind, string> = {
    "mailbox-failed": "Mailbox won't open",
    "gave-up": "Email could not be fetched",
    "sync-failed": "Central sync failed",
};

export interface RecentProblem {
    at: string;
    what: string;
    details: string;
    // open: still needs attention · solved: fixed itself (solvedAt says
    // when) · info: a record, nothing to solve (a Migadu delay).
    state: "open" | "solved" | "info";
    solvedAt: string | null;
    // A stored problem that happened more than once while open: how often,
    // and when it first did (`at` is the latest).
    times?: number;
    firstAt?: string;
}

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
    let storedProblems: RecentProblem[] = [];
    let openGaveUp = 0;

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
             WHERE migadu_hold_seconds > 300 AND received_at >= now() - make_interval(days => $1)
             ORDER BY received_at DESC LIMIT $2`,
            [PROBLEM_KEEP_DAYS, RECENT_LIMIT]
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

        await db.query(
            `DELETE FROM status_problems
             WHERE solved_at < now() - make_interval(days => $1) OR at < now() - make_interval(days => $2)`,
            [SOLVED_KEEP_DAYS, PROBLEM_KEEP_DAYS]
        );
        const p = await db.query<{ at: Date; last_at: Date; times: number; kind: ProblemKind; detail: string; solved_at: Date | null }>(
            `SELECT at, last_at, times, kind, detail, solved_at FROM status_problems
             ORDER BY (solved_at IS NULL) DESC, last_at DESC LIMIT $1`,
            [RECENT_LIMIT]
        );
        storedProblems = p.rows.map((x) => ({
            at: new Date(x.last_at).toISOString(),
            what: PROBLEM_LABELS[x.kind] ?? x.kind,
            details: x.detail,
            times: x.times,
            firstAt: new Date(x.at).toISOString(),
            state: x.solved_at ? "solved" : "open",
            solvedAt: x.solved_at ? new Date(x.solved_at).toISOString() : null,
        }));

        const g = await db.query<{ n: string }>(
            "SELECT count(*) AS n FROM status_problems WHERE kind = 'gave-up' AND solved_at IS NULL"
        );
        openGaveUp = Number(g.rows[0]?.n ?? 0);
    } catch (error) {
        problems.push(`Database not reachable: ${error instanceof Error ? error.message : String(error)}`);
    }

    // --- Verification codes (Step 27) -----------------------------------------
    // A code expiring unused is a staff miss, not a system fault: warning only.
    let codes: CodeStatus | { error: string };

    try {
        codes = await fetchCodeStatus();

        if (codes.warning) {
            warnings.push(codes.warning);
        }
    } catch (error) {
        codes = { error: error instanceof Error ? error.message : String(error) };
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

    if (openGaveUp > 0) {
        warnings.push(`${openGaveUp} email(s) could not be fetched after 5 tries and are not recovered yet (search the student to recover).`);
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
    // Open problems first (newest first), then solved ones and Migadu delays.
    const recent: RecentProblem[] = [
        ...("recent" in codes ? codes.recent : []),
        ...recentDelays.map((d) => ({
            at: d.at,
            what: "Migadu delay",
            details: `Held ${d.minutes} min · queue ${d.queue ?? "unknown"} · ${d.from} → ${d.student}`,
            state: "info" as const,
            solvedAt: null,
        })),
        ...storedProblems,
    ]
        .sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.at.localeCompare(a.at))
        .slice(0, RECENT_LIMIT);

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
        codes: "error" in codes ? codes : { days: codes.days, timeline: codes.timeline },
        database,
        server,
        ...extra,
        recent,
    };
}
