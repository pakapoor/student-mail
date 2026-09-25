import { db } from "./db.js";
import { broadcast } from "./realtime.js";
import { checkStudentMailbox, type CheckOutcome } from "./checkStudentMail.js";

// Hot list (Step 20, user): after an Edugate verification code arrives, a
// staff member has typed it into Edugate and is sitting waiting for the
// registration email with the login + password. Migadu isn't fully
// reliable, so during that window the student's OWN mailbox is checked
// directly - every 30 s for the first 5 minutes (the registration email
// normally lands 20-60 s after the code), then every 2 min until the code
// expires. Whatever the console is missing is added right away (same
// read-only check as the console search / sweep), which flips the student
// to REGISTERED and chimes.
//
// No table of its own: "hot" is derived from the Step 18 status columns, so
// the list maintains itself -
//   code_sent_at within HOT_WINDOW_MIN (code validity 30 min + 5 grace)
//   AND no registration email sent after that code.
// A registration email arriving, or the code expiring, drops the student;
// a new code (even after registration) makes them hot again.
//
// Config: HOT_ENABLED (default true), HOT_FAST_INTERVAL_S (30),
// HOT_FAST_MINUTES (5), HOT_INTERVAL_S (120), HOT_WINDOW_MIN (35).

const ENABLED = process.env.HOT_ENABLED !== "false";
const FAST_INTERVAL_MS = Number(process.env.HOT_FAST_INTERVAL_S || 30) * 1000;
const FAST_WINDOW_MS = Number(process.env.HOT_FAST_MINUTES || 5) * 60 * 1000;
const INTERVAL_MS = Number(process.env.HOT_INTERVAL_S || 120) * 1000;
const WINDOW_MIN = Number(process.env.HOT_WINDOW_MIN || 35);
const TICK_MS = 10 * 1000;
const MAX_PARALLEL = 5;
const SUMMARY_EVERY_MS = 60 * 60 * 1000;

interface HotStudent {
    id: string;
    email: string;
    smtp_password: string;
    central_email: string;
    college_id: string | null;
    code_sent_at: Date;
}

// When each hot student's mailbox was last checked (in memory - after a
// restart everyone still hot is simply checked again straight away).
const lastChecked = new Map<string, number>();
const stats = { students: new Set<string>(), checks: 0, recovered: 0, failed: 0, since: Date.now() };
let running = false;

export function startHotList(): void {
    if (!ENABLED) {
        console.log("[hot] disabled (HOT_ENABLED=false)");
        return;
    }

    console.log(
        `[hot] started: code → every ${FAST_INTERVAL_MS / 1000} s for ${FAST_WINDOW_MS / 60000} min, ` +
            `then every ${INTERVAL_MS / 1000} s, until registered or ${WINDOW_MIN} min after the code`
    );
    setInterval(() => {
        if (running) {
            return;
        }

        running = true;
        tick()
            .catch((error) => console.error("[hot] tick failed:", error))
            .finally(() => {
                running = false;
            });
    }, TICK_MS).unref?.();
}

// Students whose mailbox is being watched right now (see the rule above).
export async function findHotStudents(): Promise<HotStudent[]> {
    const hot = await db.query<HotStudent>(
        `SELECT id, email, smtp_password, central_email, college_id, code_sent_at
         FROM students
         WHERE deleted_at IS NULL
           AND central_email IS NOT NULL
           AND smtp_password <> ''
           AND code_sent_at IS NOT NULL
           AND code_sent_at > NOW() - make_interval(mins => $1)
           AND (registered_at IS NULL OR code_sent_at > registered_at)
         ORDER BY code_sent_at DESC`,
        [WINDOW_MIN]
    );

    return hot.rows;
}

async function tick(): Promise<void> {
    const hotRows = await findHotStudents();
    const now = Date.now();
    const hotIds = new Set(hotRows.map((s) => s.id));

    // Forget students who are no longer hot (registered / expired).
    for (const id of lastChecked.keys()) {
        if (!hotIds.has(id)) {
            lastChecked.delete(id);
        }
    }

    const due = hotRows
        .filter((s) => {
            const age = now - new Date(s.code_sent_at).getTime();
            const interval = age < FAST_WINDOW_MS ? FAST_INTERVAL_MS : INTERVAL_MS;
            return now - (lastChecked.get(s.id) ?? 0) >= interval;
        })
        .slice(0, MAX_PARALLEL);

    await Promise.all(
        due.map(async (s) => {
            lastChecked.set(s.id, Date.now());
            stats.students.add(s.id);
            stats.checks++;

            const outcome: CheckOutcome = await checkStudentMailbox(
                { id: Number(s.id), email: s.email, password: s.smtp_password },
                s.central_email,
                true,
                "hot"
            );

            if (outcome.status === "ok" && outcome.added > 0) {
                stats.recovered += outcome.added;

                if (s.college_id) {
                    broadcast(
                        "update",
                        { reason: "new-mail", inserted: outcome.added, collegeIds: [String(s.college_id)] },
                        s.central_email
                    );
                }
            } else if (outcome.status === "failed") {
                stats.failed++;
            }
        })
    );

    if (now - stats.since >= SUMMARY_EVERY_MS) {
        if (stats.checks > 0) {
            console.log(
                `[hot] last hour: students=${stats.students.size} checks=${stats.checks} ` +
                    `recovered=${stats.recovered} failed=${stats.failed}`
            );
        }

        stats.students.clear();
        stats.checks = 0;
        stats.recovered = 0;
        stats.failed = 0;
        stats.since = now;
    }
}
