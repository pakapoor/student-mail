// Step 53: no background job may stop silently. On 2026-10-28 one central
// sync pass never settled and every later pass was skipped for 41 hours; the
// hot list, the sweep and the other loops had the same "wait until the last
// run finishes" pattern with no limit.
//
// runJob() runs one round of a job: never two at once, never longer than its
// hard limit (a run still going after that is abandoned and logged, and the
// next round may start), errors are caught and logged. Every round that
// completes records a heartbeat. overdueJobs() lists jobs whose last
// completed round is older than their expected gap: that is an outage
// (red banner, alert email - syncAlert.ts).

export interface JobInfo {
    name: string;
    label: string;
    // A completed round is expected at least this often; longer = outage.
    overdueAfterMs: number;
    lastOkAt: number;
    lastError: string | null;
    abandoned: number;
}

const jobs = new Map<string, JobInfo>();
const running = new Map<string, symbol>();

export class JobAbandoned extends Error {}

// Registers a job (again: keeps its heartbeat). Until its first completed
// round, its "last ok" is the registration time, so a job that never manages
// a round still turns overdue.
export function registerJob(name: string, label: string, overdueAfterMs: number, now = Date.now()): void {
    const current = jobs.get(name);
    jobs.set(name, {
        name,
        label,
        overdueAfterMs,
        lastOkAt: current?.lastOkAt ?? now,
        lastError: current?.lastError ?? null,
        abandoned: current?.abandoned ?? 0,
    });
}

export function beat(name: string, now = Date.now()): void {
    const job = jobs.get(name);

    if (job) {
        job.lastOkAt = now;
        job.lastError = null;
    }
}

export function jobInfo(name: string): JobInfo | undefined {
    const job = jobs.get(name);
    return job ? { ...job } : undefined;
}

export function allJobs(): JobInfo[] {
    return [...jobs.values()].map((job) => ({ ...job }));
}

export function overdueJobs(now = Date.now()): (JobInfo & { overdueForMs: number })[] {
    return allJobs()
        .filter((job) => now - job.lastOkAt > job.overdueAfterMs)
        .map((job) => ({ ...job, overdueForMs: now - job.lastOkAt }));
}

export function isJobRunning(name: string): boolean {
    return running.has(name);
}

// One round of `name`. Returns "ok", "failed", "abandoned" or "skipped" (a
// round is still running). Never throws.
export async function runJob(
    name: string,
    work: () => Promise<unknown>,
    limitMs: number
): Promise<"ok" | "failed" | "abandoned" | "skipped"> {
    if (running.has(name)) {
        return "skipped";
    }

    const token = Symbol(name);
    running.set(name, token);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const round = Promise.resolve().then(work);
        const limit = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                round.catch(() => {});
                reject(new JobAbandoned(`${name}: a round did not finish within ${Math.round(limitMs / 1000)} s; abandoned so the next round can run`));
            }, limitMs);
        });

        await Promise.race([round, limit]);
        beat(name);
        return "ok";
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const job = jobs.get(name);

        if (job) {
            job.lastError = message;
        }

        if (error instanceof JobAbandoned) {
            if (job) {
                job.abandoned++;
            }

            console.error(`[job] ABANDONED ${message}`);
            return "abandoned";
        }

        console.error(`[job] ${name} failed:`, message);
        return "failed";
    } finally {
        clearTimeout(timer);

        if (running.get(name) === token) {
            running.delete(name);
        }
    }
}

// Tests only.
export function resetJobs(): void {
    jobs.clear();
    running.clear();
}
