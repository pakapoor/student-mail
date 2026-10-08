import { db } from "./db.js";
import { registerStatusProvider } from "./systemStatus.js";
import { REQUEST_TIMEOUT_MS, type TimedCall } from "./migadu.js";

// How long each call to the Migadu mailbox API takes. Every call is (1) written
// to the server log as an [audit] line and (2) stored in migadu_calls for 30
// days, so the status page can graph it and the call timeout (migadu.ts) can be
// set from the real slowest calls instead of a guess. Recording never throws.

const KEEP_DAYS = 30;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPrune = 0;

// Rows older than KEEP_DAYS are deleted (done at most once an hour, when a call is recorded).
export function pruneOldCalls(): Promise<unknown> {
    return db.query(`DELETE FROM migadu_calls WHERE at < now() - interval '${KEEP_DAYS} days'`);
}

export function recordMigaduCall(call: TimedCall): void {
    console.log(`[audit] ${JSON.stringify({ at: new Date().toISOString(), event: "migadu-call", ...call })}`);

    db.query("INSERT INTO migadu_calls (operation, ms, outcome) VALUES ($1, $2, $3)", [call.operation, call.ms, call.outcome]).catch(
        (error) => console.error("Could not store a Migadu call timing:", error instanceof Error ? error.message : error)
    );

    if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        pruneOldCalls().catch(() => {});
    }
}

const WINDOW_DAYS = 7;

// The status page card: the last 7 days as one point per hour (calls, median and
// slowest milliseconds, how many did not end ok), the figures over the whole
// window, the five slowest calls, and the timeout in force.
export async function migaduTimingStatus() {
    const summary = await db.query<{
        calls: string;
        median: number | null;
        p95: number | null;
        slowest: number | null;
        not_ok: string;
        timeouts: string;
    }>(
        `SELECT count(*) AS calls,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS median,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
                max(ms) AS slowest,
                count(*) FILTER (WHERE outcome <> 'ok') AS not_ok,
                count(*) FILTER (WHERE outcome = 'timeout') AS timeouts
         FROM migadu_calls WHERE at > now() - interval '${WINDOW_DAYS} days'`
    );
    const hours = await db.query<{ hour: Date; calls: string; median: number; slowest: number; not_ok: string }>(
        `SELECT date_trunc('hour', at) AS hour,
                count(*) AS calls,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS median,
                max(ms) AS slowest,
                count(*) FILTER (WHERE outcome <> 'ok') AS not_ok
         FROM migadu_calls WHERE at > now() - interval '${WINDOW_DAYS} days'
         GROUP BY 1 ORDER BY 1`
    );
    const slowest = await db.query<{ at: Date; operation: string; ms: number; outcome: string }>(
        `SELECT at, operation, ms, outcome FROM migadu_calls
         WHERE at > now() - interval '${WINDOW_DAYS} days' ORDER BY ms DESC LIMIT 5`
    );
    const s = summary.rows[0];

    return {
        timeoutMs: REQUEST_TIMEOUT_MS,
        windowDays: WINDOW_DAYS,
        summary: {
            calls: Number(s?.calls ?? 0),
            medianMs: s?.median === null || s?.median === undefined ? null : Math.round(s.median),
            p95Ms: s?.p95 === null || s?.p95 === undefined ? null : Math.round(s.p95),
            slowestMs: s?.slowest ?? null,
            notOk: Number(s?.not_ok ?? 0),
            timeouts: Number(s?.timeouts ?? 0),
        },
        hours: hours.rows.map((h) => ({
            at: h.hour.toISOString(),
            calls: Number(h.calls),
            medianMs: Math.round(h.median),
            slowestMs: h.slowest,
            notOk: Number(h.not_ok),
        })),
        slowest: slowest.rows.map((r) => ({ at: r.at.toISOString(), operation: r.operation, ms: r.ms, outcome: r.outcome })),
    };
}

registerStatusProvider("migadu", migaduTimingStatus);
