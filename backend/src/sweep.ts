import { db } from "./db.js";
import { broadcast } from "./realtime.js";
import { checkStudentMailbox, type CheckOutcome } from "./checkStudentMail.js";

// Rolling daily sweep (Step 17 A): every student's own INBOX is checked
// once per SWEEP_ROUND_HOURS (default 24), a few mailboxes at a time, spread
// evenly through the day - 5 every ~3 minutes for ~2300 students, ~2300
// logins/day, a gentle steady load on Migadu instead of a nightly burst.
// It recovers the rare email that never reached the console (the same
// mailbox check the console search runs: read-only, last 7 days, only
// missing emails added). Next up are the students swept longest ago
// (students.last_swept_at, migration 008), so it resumes where it left off
// after restarts. Recovered emails trigger the new-mail chime.
//
// Also the tripwire for the unbuilt hot-list proposal (PROJECT.md "Step
// 17b"): every `[sweep] RECOVERED` line is an email a student had that the
// console didn't.
//
// Config: SWEEP_ENABLED (default true; "false" turns it off),
// SWEEP_ROUND_HOURS (24), SWEEP_BATCH_SIZE (5).

const ENABLED = process.env.SWEEP_ENABLED !== "false";
const ROUND_HOURS = Math.max(0.01, Number(process.env.SWEEP_ROUND_HOURS || 24));
const BATCH_SIZE = Math.max(1, Math.floor(Number(process.env.SWEEP_BATCH_SIZE || 5)));
const MIN_INTERVAL_MS = 20 * 1000;
// Several network failures in one batch → Migadu or our network is having
// trouble; back off instead of hammering it.
const NETWORK_FAILURES_TO_PAUSE = 3;
const PAUSE_MS = 15 * 60 * 1000;

interface SweepStudent {
    id: string;
    email: string;
    smtp_password: string;
    central_email: string;
    college_id: string | null;
}

// Running totals, logged once per round so the log stays quiet otherwise.
const totals = { checked: 0, added: 0, failed: 0, since: Date.now() };

let timer: NodeJS.Timeout | null = null;

export function startSweep(): void {
    if (!ENABLED) {
        console.log("[sweep] disabled (SWEEP_ENABLED=false)");
        return;
    }

    console.log(`[sweep] started: one round every ${ROUND_HOURS} h, ${BATCH_SIZE} mailboxes per batch`);
    schedule(MIN_INTERVAL_MS);
}

function schedule(delayMs: number) {
    timer = setTimeout(() => {
        runBatch()
            .then((next) => schedule(next))
            .catch((error) => {
                console.error("[sweep] batch failed:", error);
                schedule(PAUSE_MS);
            });
    }, delayMs);
    timer.unref?.();
}

// Runs one batch; returns how long to wait before the next one.
async function runBatch(): Promise<number> {
    const countResult = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM students
         WHERE deleted_at IS NULL AND central_email IS NOT NULL AND smtp_password <> ''`
    );
    const studentCount = Number(countResult.rows[0]?.n ?? 0);

    // Spread one full round evenly over SWEEP_ROUND_HOURS.
    const batchesPerRound = Math.max(1, Math.ceil(studentCount / BATCH_SIZE));
    const intervalMs = Math.max(MIN_INTERVAL_MS, (ROUND_HOURS * 3600 * 1000) / batchesPerRound);

    const batch = await db.query<SweepStudent>(
        `SELECT id, email, smtp_password, central_email, college_id
         FROM students
         WHERE deleted_at IS NULL AND central_email IS NOT NULL AND smtp_password <> ''
         ORDER BY last_swept_at ASC NULLS FIRST, id
         LIMIT $1`,
        [BATCH_SIZE]
    );

    if (batch.rows.length === 0) {
        return intervalMs;
    }

    const outcomes = await Promise.all(
        batch.rows.map(async (s) => {
            const outcome: CheckOutcome = await checkStudentMailbox(
                { id: Number(s.id), email: s.email, password: s.smtp_password },
                s.central_email,
                false,
                "sweep"
            );

            // Marked as swept even when the check failed, so a student with
            // a wrong stored password can't block the queue.
            await db.query("UPDATE students SET last_swept_at = NOW() WHERE id = $1", [s.id]);

            if (outcome.status === "ok" && outcome.added > 0 && s.college_id) {
                // Same event as a normal new-mail sync: lists refresh and
                // the console for that college chimes.
                broadcast("update", { reason: "new-mail", inserted: outcome.added, collegeIds: [String(s.college_id)] }, s.central_email);
            }

            return outcome;
        })
    );

    for (const o of outcomes) {
        totals.checked++;
        if (o.status === "ok") totals.added += o.added;
        else totals.failed++;
    }

    if (Date.now() - totals.since >= ROUND_HOURS * 3600 * 1000) {
        console.log(
            `[sweep] round summary (last ${ROUND_HOURS} h): checked=${totals.checked} ` +
                `added=${totals.added} failed=${totals.failed} students=${studentCount}`
        );
        totals.checked = 0;
        totals.added = 0;
        totals.failed = 0;
        totals.since = Date.now();
    }

    const networkFailures = outcomes.filter(
        (o) => o.status === "failed" && (o.reason === "network" || o.reason === "timeout")
    ).length;

    if (networkFailures >= NETWORK_FAILURES_TO_PAUSE) {
        console.warn(`[sweep] ${networkFailures} network failures in one batch - pausing ${PAUSE_MS / 60000} min`);
        return PAUSE_MS;
    }

    return intervalMs;
}
