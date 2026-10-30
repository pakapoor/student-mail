import { db } from "./db.js";
import { broadcast } from "./realtime.js";
import { checkStudentMailbox, type CheckOutcome } from "./checkStudentMail.js";
import { registerJob, runJob } from "./jobHealth.js";

// Step 53 (owner): the students staff are working on are checked every 5 min,
// so a code reaches the console within minutes even if the central sync
// fails. "Active" = not registered yet AND (added in the last 14 days OR an
// Edugate email in the last 7 days) - about 20 students on 2026-10-30.
// Everyone else stays on the daily sweep (sweep.ts).
//
// Load cap: at most ACTIVE_MAX_PER_HOUR checks an hour. With more active
// students than the cap allows at 5 min (50 at 600/hour), each one's interval
// stretches evenly (125 after a bulk add -> about every 12.5 min), most
// overdue first.

export const ACTIVE_INTERVAL_MS = Number(process.env.ACTIVE_INTERVAL_MIN || 5) * 60 * 1000;
export const ACTIVE_MAX_PER_HOUR = Number(process.env.ACTIVE_MAX_PER_HOUR || 600);
export const ACTIVE_ADDED_DAYS = 14;
export const ACTIVE_EDUGATE_DAYS = 7;
const ENABLED = process.env.ACTIVE_ENABLED !== "false";
const TICK_MS = 60 * 1000;
const MAX_PARALLEL = 10;
export const ACTIVE_ROUND_LIMIT_MS = 3 * 60 * 1000;
export const ACTIVE_OVERDUE_MS = 10 * 60 * 1000;

export interface ActiveStudent {
    id: string;
    email: string;
    smtp_password: string;
    central_email: string;
    college_id: string | null;
}

// When each active student was last checked by this job (in memory: after a
// restart everyone is due straight away).
const lastChecked = new Map<string, number>();
const stats = { checks: 0, recovered: 0, failed: 0 };

export async function findActiveStudents(): Promise<ActiveStudent[]> {
    const result = await db.query<ActiveStudent>(
        `SELECT s.id, s.email, s.smtp_password, s.central_email, s.college_id
         FROM students s
         WHERE s.deleted_at IS NULL
           AND s.mailbox_confirmed_at IS NOT NULL
           AND s.central_email IS NOT NULL
           AND s.smtp_password <> ''
           AND s.registered_at IS NULL
           AND (
                s.created_at > now() - make_interval(days => $1)
             OR EXISTS (
                    SELECT 1 FROM messages m
                    WHERE lower(m.student_email) = s.email
                      AND m.received_at > now() - make_interval(days => $2)
                      AND (m.edugate_kind IS NOT NULL OR lower(m.sender_email) LIKE '%@edu.gov.kg')
                )
           )
         ORDER BY s.id`,
        [ACTIVE_ADDED_DAYS, ACTIVE_EDUGATE_DAYS]
    );
    return result.rows;
}

// Pure: the interval each active student gets - 5 min, stretched so that
// all of them together stay under the hourly cap.
export function activeInterval(activeCount: number, baseMs = ACTIVE_INTERVAL_MS, maxPerHour = ACTIVE_MAX_PER_HOUR): number {
    if (activeCount <= 0 || maxPerHour <= 0) {
        return baseMs;
    }

    return Math.max(baseMs, Math.ceil((activeCount * 60 * 60 * 1000) / maxPerHour));
}

// Pure: who is due now, most overdue first (never checked = most overdue),
// at most `perTick` of them. perTick keeps one minute's checks under the
// hourly cap.
export function pickDue<T extends { id: string }>(
    students: T[],
    last: Map<string, number>,
    now: number,
    intervalMs: number,
    perTick: number
): T[] {
    return students
        .filter((s) => !last.has(s.id) || now - last.get(s.id)! >= intervalMs)
        .sort(
            (a, b) =>
                (last.get(a.id) ?? Number.NEGATIVE_INFINITY) - (last.get(b.id) ?? Number.NEGATIVE_INFINITY) ||
                Number(a.id) - Number(b.id)
        )
        .slice(0, Math.max(0, perTick));
}

export function perTickLimit(maxPerHour = ACTIVE_MAX_PER_HOUR, tickMs = TICK_MS): number {
    return Math.max(1, Math.floor((maxPerHour * tickMs) / (60 * 60 * 1000)));
}

export async function activeTick(
    now = Date.now(),
    check: typeof checkStudentMailbox = checkStudentMailbox
): Promise<{ active: number; checked: number }> {
    const active = await findActiveStudents();
    const ids = new Set(active.map((s) => s.id));

    for (const id of lastChecked.keys()) {
        if (!ids.has(id)) {
            lastChecked.delete(id);
        }
    }

    const due = pickDue(active, lastChecked, now, activeInterval(active.length), Math.min(MAX_PARALLEL, perTickLimit()));

    await Promise.all(
        due.map(async (s) => {
            lastChecked.set(s.id, now);
            stats.checks++;
            const outcome: CheckOutcome = await check(
                { id: Number(s.id), email: s.email, password: s.smtp_password },
                s.central_email,
                true,
                "active"
            );

            if (outcome.status === "ok" && outcome.added > 0) {
                stats.recovered += outcome.added;
                broadcast(
                    "update",
                    { reason: "new-mail", inserted: outcome.added, collegeIds: s.college_id ? [String(s.college_id)] : [] },
                    s.central_email
                );
            } else if (outcome.status === "failed") {
                stats.failed++;
            }
        })
    );

    return { active: active.length, checked: due.length };
}

export function startActiveCheck(): void {
    if (!ENABLED) {
        console.log("[active] disabled (ACTIVE_ENABLED=false)");
        return;
    }

    console.log(
        `[active] started: students in progress checked every ${ACTIVE_INTERVAL_MS / 60000} min, at most ${ACTIVE_MAX_PER_HOUR} checks an hour`
    );
    registerJob("active-check", "5-minute check of students in progress", ACTIVE_OVERDUE_MS);
    setInterval(() => {
        void runJob("active-check", () => activeTick(), ACTIVE_ROUND_LIMIT_MS);
    }, TICK_MS).unref?.();
}

export function activeStats() {
    return { ...stats, tracked: lastChecked.size };
}

// Tests only.
export function resetActiveCheck(): void {
    lastChecked.clear();
    stats.checks = 0;
    stats.recovered = 0;
    stats.failed = 0;
}
