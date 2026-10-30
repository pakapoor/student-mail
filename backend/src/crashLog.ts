import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db } from "./db.js";

// Step 53: every crash is shown on the status page and emailed. The backend
// keeps a small state file: when it started, when it was last alive (written
// every minute), when it stopped cleanly, and - written at the moment of a
// crash - the error that killed it. At the next start, a previous run without
// a clean stop was a crash. The database may be what died, so this is a file,
// not a table; the crash is stored in status_problems once the database
// answers.

export interface RunState {
    pid: number;
    startedAt: number;
    aliveAt: number;
    cleanStopAt?: number;
    crash?: { at: number; message: string };
}

export interface CrashFound {
    crashedAt: number;
    startedAt: number;
    downMs: number;
    cause: string;
}

const UNKNOWN_CAUSE = "no cause recorded: the backend was killed, ran out of memory, hung and was restarted, or the server went down";

export function stateFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.resolve(env.RUN_STATE_DIR || path.join(process.cwd(), ".run"), "run-state.json");
}

export function readState(file = stateFile()): RunState | null {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as RunState;
        return typeof parsed?.startedAt === "number" ? parsed : null;
    } catch {
        return null;
    }
}

// Written to a temporary file and renamed, so a crash mid-write never leaves
// half a file. Synchronous: it also runs inside the crash handler.
export function writeState(state: RunState, file = stateFile()): void {
    try {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(state));
        renameSync(tmp, file);
    } catch (error) {
        console.error("[crash] could not write the run state:", error instanceof Error ? error.message : error);
    }
}

// Pure: was the previous run a crash?
export function detectCrash(previous: RunState | null, now: number): CrashFound | null {
    if (!previous || previous.cleanStopAt !== undefined) {
        return null;
    }

    const crashedAt = previous.crash?.at ?? previous.aliveAt ?? previous.startedAt;

    return {
        crashedAt,
        startedAt: now,
        downMs: Math.max(0, now - crashedAt),
        cause: previous.crash?.message || UNKNOWN_CAUSE,
    };
}

let current: RunState | null = null;
let pendingStore: CrashFound | null = null;
let pendingEmail: CrashFound | null = null;

// At startup: looks at the previous run, then starts a new state.
export function beginRun(now = Date.now(), file = stateFile()): CrashFound | null {
    const crash = detectCrash(readState(file), now);
    current = { pid: process.pid, startedAt: now, aliveAt: now };
    writeState(current, file);

    if (crash) {
        pendingStore = crash;
        pendingEmail = crash;
        console.error(
            `[crash] the previous run CRASHED at ${new Date(crash.crashedAt).toISOString()} (down ${Math.round(crash.downMs / 1000)} s): ${crash.cause}`
        );
    }

    return crash;
}

export function markAlive(now = Date.now(), file = stateFile()): void {
    if (current) {
        current.aliveAt = now;
        writeState(current, file);
    }
}

export function recordCrash(error: unknown, now = Date.now(), file = stateFile()): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const state = current ?? { pid: process.pid, startedAt: now, aliveAt: now };
    state.crash = { at: now, message: message.slice(0, 1000) };
    current = state;
    writeState(state, file);
}

export function markCleanStop(now = Date.now(), file = stateFile()): void {
    const state = current ?? { pid: process.pid, startedAt: now, aliveAt: now };
    state.cleanStopAt = now;
    current = state;
    writeState(state, file);
}

// Stores a detected crash in status_problems (kind backend-crash, already
// solved: it is a past event). Returns false if the database did not answer;
// the alert loop tries again.
export async function storePendingCrash(): Promise<boolean> {
    if (!pendingStore) {
        return true;
    }

    const crash = pendingStore;

    try {
        await db.query(
            `INSERT INTO status_problems (at, last_at, kind, subject, source, detail, solved_at)
             VALUES ($1, $1, 'backend-crash', $2, 'backend', $3, $4)`,
            [
                new Date(crash.crashedAt),
                `crash ${new Date(crash.crashedAt).toISOString()}`,
                `Down ${Math.max(1, Math.round(crash.downMs / 1000))} s · ${crash.cause}`,
                new Date(crash.startedAt),
            ]
        );
        pendingStore = null;
        return true;
    } catch (error) {
        console.error("[crash] could not store the crash yet:", error instanceof Error ? error.message : error);
        return false;
    }
}

// The alert loop takes the crash to email exactly once.
export function takeCrashToEmail(): CrashFound | null {
    const crash = pendingEmail;
    pendingEmail = null;
    return crash;
}

// Crash handlers and the clean stop. An uncaught error still ends the process
// (state may be broken; systemd starts a fresh one), but its cause is kept.
export function installCrashHandlers(onStop: () => Promise<void> = async () => {}): void {
    const die = (kind: string) => (error: unknown) => {
        recordCrash(error);
        console.error(`[crash] ${kind}, the backend stops now and systemd restarts it:`, error);
        process.exit(1);
    };

    process.on("uncaughtException", die("uncaught exception"));
    process.on("unhandledRejection", die("unhandled promise rejection"));

    const stop = (signal: string) => {
        markCleanStop();
        console.log(`[crash] clean stop (${signal})`);
        const exit = setTimeout(() => process.exit(0), 3000);
        exit.unref();
        onStop()
            .catch(() => {})
            .finally(() => process.exit(0));
    };

    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
}

// Tests only.
export function resetCrashLog(): void {
    current = null;
    pendingStore = null;
    pendingEmail = null;
}
