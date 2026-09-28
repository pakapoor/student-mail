import { db } from "./db.js";
import { classifyEdugate } from "../../shared/edugate.js";

// Code expiry alerts (Step 27, user). A verification code that expires with
// no registration email means staff missed it and the student has to ask
// Edugate for a fresh code. Two consumers, one set of rules (this file), so
// they can never disagree:
//   - the console's alert rows (GET /api/codes/alerts): amber while a code
//     is in its last 5 minutes, red once it has expired unused;
//   - the status page: expiries per day, how many were handled (a fresh
//     code arrived) and how fast, and which are still waiting.
// Nothing is stored - everything is derived from the code / login emails
// already in the messages table, so it survives restarts and covers past
// days straight away.
//
// Rules, per code email:
//   used          - a registration (login) email SENT between the code and
//                   its expiry + 5 min grace (same grace as the hot list)
//   replaced      - a newer code arrived before this one expired (not a miss)
//   expired unused- neither of the above, and the expiry time has passed
//   handled       - for an expired-unused code: the next code for that
//                   student (user: "handled means fresh code arrived");
//                   time to handle = that code's time minus the expiry
//   open          - expired unused, no fresh code and no registration yet
//   Migadu-delayed- the code email itself was held by Migadu > 5 min, so
//                   the miss may not be the staff's fault

const DEFAULT_VALID_MINUTES = 30;
const GRACE_MS = 5 * 60 * 1000;
const WARN_BEFORE_MS = 5 * 60 * 1000;
const MIGADU_DELAY_SECONDS = 300;
// Red rows (user): fewer than 5 open expiries → show them all until handled
// (up to 24 h); 5 or more → only those from the last 30 min, plus a count of
// the older ones.
const SHOW_ALL_BELOW = 5;
const RECENT_MS = 30 * 60 * 1000;
const MAX_SHOW_MS = 24 * 60 * 60 * 1000;
// Status page: a table of expiries per day for this many days, and a live
// line graph of the running count over the last 6 h, one point every 5 min
// (user: continuous, only the most recent matters, and "whats gone is
// gone" - a fixed sliding window, no browsing back).
export const STATUS_DAYS = 7;
export const TIMELINE_STEP_MIN = 5;
export const TIMELINE_HOURS = 6;

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

export interface CodeRow {
    id: number;
    email: string;
    at: number;
    validMinutes: number;
    heldSeconds: number | null;
    name: string | null;
    appNo: string | null;
}

export interface CodeOutcome extends CodeRow {
    expiresAt: number;
    used: boolean;
    replaced: boolean;
    freshCodeAt: number | null;
    registeredAt: number | null;
    migaduDelayed: boolean;
}

// Pure: codes + each student's login times → the outcome of every code.
export function analyzeCodes(codes: CodeRow[], loginsByEmail: Map<string, number[]>): CodeOutcome[] {
    const byEmail = new Map<string, CodeRow[]>();

    for (const c of codes) {
        const list = byEmail.get(c.email) ?? [];
        list.push(c);
        byEmail.set(c.email, list);
    }

    const out: CodeOutcome[] = [];

    for (const [email, list] of byEmail) {
        list.sort((a, b) => a.at - b.at);
        const logins = loginsByEmail.get(email) ?? [];

        list.forEach((c, i) => {
            const expiresAt = c.at + c.validMinutes * MIN_MS;
            const next = list[i + 1];
            const used = logins.some((t) => t >= c.at && t <= expiresAt + GRACE_MS);
            const replaced = next !== undefined && next.at < expiresAt;
            const firstLogin = logins.filter((t) => t >= c.at).sort((a, b) => a - b)[0];

            out.push({
                ...c,
                expiresAt,
                used,
                replaced,
                freshCodeAt: next !== undefined && next.at >= expiresAt ? next.at : null,
                registeredAt: firstLogin ?? null,
                migaduDelayed: (c.heldSeconds ?? 0) > MIGADU_DELAY_SECONDS,
            });
        });
    }

    return out;
}

export function expiredUnused(o: CodeOutcome, now: number): boolean {
    return !o.used && !o.replaced && now >= o.expiresAt;
}

export function isOpen(o: CodeOutcome, now: number): boolean {
    return expiredUnused(o, now) && o.freshCodeAt === null && o.registeredAt === null;
}

export interface CodeAlert {
    messageId: number;
    email: string;
    name: string | null;
    appNo: string | null;
    state: "expiring" | "expired";
    expiresAt: string;
}

export interface CodeAlertsResult {
    alerts: CodeAlert[];
    // Open expiries left out because there are 5 or more (see above).
    olderExpired: number;
    serverNow: string;
}

// Pure: which rows the console shows right now.
export function pickAlerts(outcomes: CodeOutcome[], now: number): Omit<CodeAlertsResult, "serverNow"> {
    const expiring = outcomes
        .filter((o) =>
            !o.used && !o.replaced && o.freshCodeAt === null && o.registeredAt === null &&
            now >= o.expiresAt - WARN_BEFORE_MS && now < o.expiresAt
        )
        .sort((a, b) => a.expiresAt - b.expiresAt);

    const open = outcomes
        .filter((o) => isOpen(o, now) && now - o.expiresAt < MAX_SHOW_MS)
        .sort((a, b) => b.expiresAt - a.expiresAt);

    const shown = open.length < SHOW_ALL_BELOW ? open : open.filter((o) => now - o.expiresAt < RECENT_MS);

    const toAlert = (o: CodeOutcome, state: CodeAlert["state"]): CodeAlert => ({
        messageId: o.id,
        email: o.email,
        name: o.name,
        appNo: o.appNo,
        state,
        expiresAt: new Date(o.expiresAt).toISOString(),
    });

    return {
        alerts: [...expiring.map((o) => toAlert(o, "expiring")), ...shown.map((o) => toAlert(o, "expired"))],
        olderExpired: open.length - shown.length,
    };
}

interface Scope {
    centralEmail: string;
    collegeId: string;
}

// Code emails sent since `since` (active students only; scoped to one
// console when given) plus every student's login times since then.
async function loadOutcomes(since: Date, scope?: Scope): Promise<CodeOutcome[]> {
    const params: unknown[] = [since];
    let scopeSql = "";

    if (scope) {
        params.push(scope.centralEmail, scope.collegeId);
        scopeSql = "AND m.central_email = $2 AND s.college_id = $3";
    }

    const result = await db.query<{
        id: string;
        student_email: string;
        message_id: string;
        sender_email: string;
        body_text: string | null;
        at: Date;
        migadu_hold_seconds: number | null;
        name: string | null;
        app_no: string | null;
    }>(
        `SELECT m.id, m.student_email, m.message_id, m.sender_email, m.body_text,
                coalesce(m.sent_at, m.received_at) AS at, m.migadu_hold_seconds,
                nullif(trim(coalesce(s.first_name, '') || ' ' || coalesce(s.last_name, '')), '') AS name,
                nullif(trim(s.admission_id), '') AS app_no
         FROM messages m
         JOIN students s ON s.email = m.student_email AND s.deleted_at IS NULL
         WHERE m.edugate_kind = 'code'
           AND coalesce(m.sent_at, m.received_at) > $1
           ${scopeSql}`,
        params
    );

    // The same email can be stored once per central mailbox - count it once.
    const seen = new Set<string>();
    const codes: CodeRow[] = [];

    for (const r of result.rows) {
        const email = r.student_email.toLowerCase();
        const key = `${email}\u0000${r.message_id}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        const info = classifyEdugate(r.sender_email, r.body_text, r.student_email);
        codes.push({
            id: Number(r.id),
            email,
            at: new Date(r.at).getTime(),
            validMinutes: info?.kind === "code" ? info.validMinutes : DEFAULT_VALID_MINUTES,
            heldSeconds: r.migadu_hold_seconds,
            name: r.name,
            appNo: r.app_no,
        });
    }

    const loginsByEmail = new Map<string, number[]>();

    if (codes.length > 0) {
        const logins = await db.query<{ student_email: string; at: Date }>(
            `SELECT student_email, coalesce(sent_at, received_at) AS at
             FROM messages
             WHERE edugate_kind = 'login'
               AND lower(student_email) = ANY($1)
               AND coalesce(sent_at, received_at) > $2`,
            [[...new Set(codes.map((c) => c.email))], since]
        );

        for (const l of logins.rows) {
            const email = l.student_email.toLowerCase();
            const list = loginsByEmail.get(email) ?? [];
            list.push(new Date(l.at).getTime());
            loginsByEmail.set(email, list);
        }
    }

    return analyzeCodes(codes, loginsByEmail);
}

export async function fetchCodeAlerts(centralEmail: string, collegeId: string): Promise<CodeAlertsResult> {
    const now = Date.now();
    // Oldest code that can still matter: shown up to 24 h after a 30 min
    // expiry (a little extra for longer validity).
    const since = new Date(now - MAX_SHOW_MS - 2 * 60 * MIN_MS);
    const outcomes = await loadOutcomes(since, { centralEmail, collegeId });

    return { ...pickAlerts(outcomes, now), serverNow: new Date(now).toISOString() };
}

export interface CodeDay {
    day: string;
    codes: number;
    expiredUnused: number;
    handled: number;
    open: number;
    migaduDelayed: number;
    medianMinutesToFreshCode: number | null;
}

export interface CodeTimeline {
    stepMinutes: number;
    // Oldest first, on the 5-minute marks, the last one = now. waiting = codes
    // that had expired unused by then (within the 24 h before it, as the
    // alert rows) and had no fresh code or registration yet at that moment.
    points: { at: string; waiting: number }[];
}

export interface CodeStatus {
    days: CodeDay[];
    timeline: CodeTimeline;
    recent: { at: string; what: string; details: string; state: "open" | "solved"; solvedAt: string | null }[];
    warning: string | null;
}

function median(values: number[]): number | null {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function who(o: CodeOutcome): string {
    return o.name ? `${o.name} (${o.email})` : o.email;
}

// Pure: per-day figures (days in `timeZone`, oldest first), the recent
// expiries for the "Recent problems" table, and the warning line.
export function summarizeCodes(outcomes: CodeOutcome[], now: number, timeZone: string, days = STATUS_DAYS): CodeStatus {
    let format: Intl.DateTimeFormat;

    try {
        format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
        format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
    }

    const dayOf = (t: number) => format.format(new Date(t));
    const keys: string[] = [];

    for (let i = days - 1; i >= 0; i--) {
        const key = dayOf(now - i * DAY_MS);

        if (keys[keys.length - 1] !== key) {
            keys.push(key);
        }
    }

    const rows = new Map<string, CodeDay & { toFresh: number[] }>(
        keys.map((day) => [day, { day, codes: 0, expiredUnused: 0, handled: 0, open: 0, migaduDelayed: 0, medianMinutesToFreshCode: null, toFresh: [] }])
    );

    for (const o of outcomes) {
        const sentDay = rows.get(dayOf(o.at));

        if (sentDay) {
            sentDay.codes++;
        }

        if (!expiredUnused(o, now)) {
            continue;
        }

        const row = rows.get(dayOf(o.expiresAt));

        if (!row) {
            continue;
        }

        row.expiredUnused++;
        row.migaduDelayed += o.migaduDelayed ? 1 : 0;

        if (o.freshCodeAt !== null) {
            row.handled++;
            row.toFresh.push((o.freshCodeAt - o.expiresAt) / MIN_MS);
        } else if (o.registeredAt === null) {
            row.open++;
        }
    }

    const dayRows = [...rows.values()].map(({ toFresh, ...d }) => {
        const m = median(toFresh);
        return { ...d, medianMinutesToFreshCode: m === null ? null : Math.round(m) };
    });

    const recent = outcomes
        .filter((o) => expiredUnused(o, now))
        .sort((a, b) => b.expiresAt - a.expiresAt)
        .map((o) => {
            const outcome =
                o.freshCodeAt !== null
                    ? `fresh code after ${Math.round((o.freshCodeAt - o.expiresAt) / MIN_MS)} min`
                    : o.registeredAt !== null
                      ? "registered later without a new code"
                      : "no fresh code yet";
            const delay = o.migaduDelayed ? ` · code email held ${Math.round((o.heldSeconds ?? 0) / 60)} min by Migadu` : "";
            // Solved once a fresh code arrived or the student registered anyway.
            const solvedAt = o.freshCodeAt ?? o.registeredAt;

            return {
                at: new Date(o.expiresAt).toISOString(),
                what: "Code expired unused",
                details: `${who(o)} · ${outcome}${delay}`,
                state: solvedAt === null ? ("open" as const) : ("solved" as const),
                solvedAt: solvedAt === null ? null : new Date(solvedAt).toISOString(),
            };
        });

    // Running count on every 5-minute mark, plus a final point now.
    const stepMs = TIMELINE_STEP_MIN * MIN_MS;
    const firstPoint = Math.floor((now - TIMELINE_HOURS * 60 * MIN_MS) / stepMs) * stepMs + stepMs;
    const times: number[] = [];

    for (let t = firstPoint; t < now; t += stepMs) {
        times.push(t);
    }

    times.push(now);
    const misses = outcomes.filter((o) => expiredUnused(o, now));
    const points = times.map((t) => ({
        at: new Date(t).toISOString(),
        waiting: misses.filter(
            (o) =>
                o.expiresAt <= t &&
                t - o.expiresAt < MAX_SHOW_MS &&
                (o.freshCodeAt === null || o.freshCodeAt > t) &&
                (o.registeredAt === null || o.registeredAt > t)
        ).length,
    }));

    const today = dayRows[dayRows.length - 1];
    let warning: string | null = null;

    if (today && today.expiredUnused > 0) {
        warning =
            `${today.expiredUnused} verification code${today.expiredUnused === 1 ? "" : "s"} expired unused today` +
            (today.open > 0 ? `; ${today.open} still waiting for a fresh code.` : "; all handled.");
    }

    return {
        days: dayRows,
        timeline: { stepMinutes: TIMELINE_STEP_MIN, points },
        recent,
        warning,
    };
}

export async function fetchCodeStatus(): Promise<CodeStatus> {
    const now = Date.now();
    // "Today" and the day boundaries follow the database's time zone, like
    // the other "today" figures on the status page.
    const tz = await db.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
    // One extra day so codes sent just before the first day still count.
    const outcomes = await loadOutcomes(new Date(now - (STATUS_DAYS + 1) * DAY_MS));
    return summarizeCodes(outcomes, now, tz.rows[0]?.tz ?? "UTC");
}
