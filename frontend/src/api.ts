import type {
    College,
    Session,
    AdminStudentPage,
    ImportResult,
    RosterFilter,
    StatusFilter,
    StudentRow,
    ThreadItem,
    ThreadSummary,
} from "./types";
import { apiFetch } from "./apiFetch";

// Must match the page's hostname (not just resolve to the same machine) -
// SameSite=Lax cookies are dropped on cross-site fetches, and browsers treat
// "localhost" and "127.0.0.1" as different sites even though both are local.
// In production, Nginx reverse-proxies /api on the same origin as the page,
// so VITE_API_BASE is set to "" at build time (see frontend/.env.production).
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3001";

// Filter buttons on the console (backend thread.ts ThreadFilter).
export type ThreadFilter = "code_live" | "code_expired" | "registered" | "rejected" | "other";

export interface ThreadSummaryPage {
    threads: ThreadSummary[];
    total: number;
    hasMore: boolean;
    // How many threads each filter button would show (for the search).
    counts?: Record<ThreadFilter | "all", number>;
}

const PAGE_SIZE = 25;

export async function fetchColleges(): Promise<College[]> {
    const res = await fetch(`${API_BASE}/api/colleges`);
    if (!res.ok) throw new Error("Failed to load colleges");
    return res.json();
}

export async function login(email: string, password: string): Promise<Session> {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });

    const payload = await res.json();

    if (!res.ok) {
        throw new Error(payload.error || `Login failed (${res.status})`);
    }

    return payload;
}

export async function selectCollege(collegeId: string): Promise<Session> {
    const res = await apiFetch(`${API_BASE}/api/auth/college`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collegeId }),
    });

    const payload = await res.json();

    if (!res.ok) {
        throw new Error(payload.error || `Failed to select college (${res.status})`);
    }

    return payload;
}

export async function logout(): Promise<void> {
    await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
    });
}

export async function fetchCurrentSession(): Promise<Session | null> {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
        credentials: "include",
    });

    if (res.status === 401) {
        return null;
    }

    if (!res.ok) throw new Error("Failed to check your session");

    const payload = await res.json();
    return payload;
}

export async function fetchThreadSummaries(
    status: StatusFilter,
    offset = 0,
    limit = PAGE_SIZE,
    search?: string,
    filter?: ThreadFilter | null
): Promise<ThreadSummaryPage> {
    const searchParam = search?.trim() ? `&search=${encodeURIComponent(search.trim())}` : "";
    const filterParam = filter ? `&filter=${filter}` : "";
    const res = await apiFetch(
        `${API_BASE}/api/threads?status=${status}&limit=${limit}&offset=${offset}${searchParam}${filterParam}`,
        { credentials: "include" }
    );

    if (!res.ok) {
        throw new Error(`Failed to load threads (${res.status})`);
    }

    return res.json();
}

export interface MailCheckStudent {
    id: number;
    name: string;
}

export type MailCheckOutcome =
    | { status: "ok"; checked: number; added: number; checkedAt: number }
    | { status: "failed" };

export interface MailCheckMatches {
    students: MailCheckStudent[];
    tooMany: boolean;
}

// The (at most 3) students the search narrows to - each gets its mailbox
// checked. tooMany means more matched than that; no automatic check then.
export async function fetchMailCheckMatches(search: string): Promise<MailCheckMatches> {
    const res = await apiFetch(
        `${API_BASE}/api/check-mail/match?search=${encodeURIComponent(search.trim())}`,
        { credentials: "include" }
    );

    if (!res.ok) {
        return { students: [], tooMany: false };
    }

    return res.json();
}

// Any failure (including a network/HTTP error) comes back as "failed" - the
// console deliberately shows nothing for it; the reason is in the server log.
export async function checkStudentMail(studentId: number, force: boolean): Promise<MailCheckOutcome> {
    try {
        const res = await apiFetch(`${API_BASE}/api/check-mail/${studentId}`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
        });

        if (!res.ok) {
            return { status: "failed" };
        }

        return await res.json();
    } catch {
        return { status: "failed" };
    }
}

export async function fetchThread(id: number): Promise<ThreadItem[]> {
    const res = await apiFetch(`${API_BASE}/api/messages/${id}/thread`, {
        credentials: "include",
    });

    if (!res.ok) {
        throw new Error(`Failed to load thread (${res.status})`);
    }

    return res.json();
}

// What the server says changed. reason "new-mail" carries the colleges the
// new mail is for (used for the chime); other reasons are staff actions.
export interface UpdateEvent {
    reason?: string;
    collegeIds?: string[];
}

// Live updates that never silently stop. A browser only retries an
// EventSource by itself after a network drop; after an HTTP error (401 once
// logged out, 502 while the backend restarts) it gives up for good, and the
// console would keep looking normal with no new mail arriving. So:
// - after any reconnect, report { reason: "reconnected" } - events sent
//   during the gap were missed, so the caller reloads;
// - when the browser gives up, check the session: logged out → onSignedOut,
//   otherwise try again with backoff (1 s, 2 s, 4 s … 30 s).
export function subscribeToUpdates(
    onUpdate: (event: UpdateEvent) => void,
    onSignedOut: () => void
): () => void {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let hasOpened = false;
    let failures = 0;

    const connect = () => {
        source = new EventSource(`${API_BASE}/api/events`, { withCredentials: true });

        source.addEventListener("open", () => {
            if (hasOpened) {
                onUpdate({ reason: "reconnected" });
            }
            hasOpened = true;
            failures = 0;
        });

        source.addEventListener("update", (e) => {
            let data: UpdateEvent = {};
            try {
                data = JSON.parse((e as MessageEvent).data);
            } catch {
                // Refresh anyway, just without the extra detail.
            }
            onUpdate(data);
        });

        source.addEventListener("error", () => {
            // Still CONNECTING: the browser is retrying by itself.
            if (!source || source.readyState !== EventSource.CLOSED || stopped) {
                return;
            }

            source.close();
            failures++;
            retryTimer = setTimeout(async () => {
                if (stopped) return;

                // null = logged out; a failed check (backend still starting)
                // just means try again.
                const session = await fetchCurrentSession().catch(() => undefined);

                if (stopped) return;

                if (session === null) {
                    onSignedOut();
                    return;
                }

                // Reconnecting after a give-up counts as a gap too.
                hasOpened = true;
                connect();
            }, Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)));
        });
    };

    connect();

    return () => {
        stopped = true;
        clearTimeout(retryTimer);
        source?.close();
    };
}

export async function sendReply(
    id: number,
    bodyHtml: string,
    attachments: File[]
): Promise<{ sent: true; sentMessageId: string }> {
    const formData = new FormData();
    formData.append("bodyHtml", bodyHtml);

    for (const file of attachments) {
        formData.append("attachments", file);
    }

    const res = await apiFetch(`${API_BASE}/api/messages/${id}/reply`, {
        method: "POST",
        credentials: "include",
        body: formData,
    });

    const payload = await res.json();

    if (!res.ok) {
        throw new Error(payload.error || `Failed to send reply (${res.status})`);
    }

    return payload;
}

export async function sendFollowUp(
    id: number,
    bodyHtml: string,
    attachments: File[]
): Promise<{ sent: true; sentMessageId: string }> {
    const formData = new FormData();
    formData.append("bodyHtml", bodyHtml);

    for (const file of attachments) {
        formData.append("attachments", file);
    }

    const res = await apiFetch(`${API_BASE}/api/messages/${id}/follow-up`, {
        method: "POST",
        credentials: "include",
        body: formData,
    });

    const payload = await res.json();

    if (!res.ok) {
        throw new Error(payload.error || `Failed to send message (${res.status})`);
    }

    return payload;
}

export async function fetchStudents(): Promise<StudentRow[]> {
    const res = await apiFetch(`${API_BASE}/api/students`, {
        credentials: "include",
    });

    if (!res.ok) {
        throw new Error(`Failed to load students (${res.status})`);
    }

    return res.json();
}

export async function importStudents(csv: string): Promise<ImportResult> {
    const res = await apiFetch(`${API_BASE}/api/students/import`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
    });

    const payload = await res.json();

    if (!res.ok) {
        throw new Error(payload.error || `Import failed (${res.status})`);
    }

    return payload;
}

export async function fetchAdminStudents(
    search: string,
    cursor: string | null,
    status: RosterFilter | null = null,
    collegeId: string | null = null
): Promise<AdminStudentPage> {
    const params = new URLSearchParams();

    if (status) {
        params.set("status", status);
    }

    if (collegeId) {
        params.set("college", collegeId);
    }

    if (search) {
        params.set("search", search);
    }

    if (cursor) {
        params.set("cursor", cursor);
    }

    const res = await apiFetch(`${API_BASE}/api/admin/students?${params}`, {
        credentials: "include",
    });

    if (!res.ok) {
        throw new Error(`Failed to load students (${res.status})`);
    }

    return res.json();
}

export async function markHandled(id: number): Promise<void> {
    const res = await apiFetch(`${API_BASE}/api/messages/${id}/mark-handled`, {
        method: "POST",
        credentials: "include",
    });

    if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to mark as handled (${res.status})`);
    }
}

// Code expiry alert rows (Step 27). Shape of backend codeAlerts.ts.
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
    olderExpired: number;
    serverNow: string;
}

export async function fetchCodeAlerts(): Promise<CodeAlertsResult> {
    const res = await apiFetch(`${API_BASE}/api/codes/alerts`, { credentials: "include" });

    if (!res.ok) {
        throw new Error(`Could not load code alerts (${res.status})`);
    }

    return res.json();
}

// System status page (/status). Shape of backend systemStatus.ts.
export interface SystemStatus {
    generatedAt: string;
    activityCoverage?: { since: string; maxEvents: number; retainedEvents: number; approximate: boolean };
    overall: "ok" | "warning" | "problem";
    problems: string[];
    warnings: string[];
    sync: { mailboxes: { email: string; connected: boolean; lastSuccessAt: string | null }[]; emailsToday: number };
    retries: { retriedToday: number; gaveUpToday: number };
    recoveredToday: { search: number; sweep: number; hot: number };
    mailboxFailures24h: number;
    delays: { heldOver5MinToday?: number; longestTodaySeconds?: number | null; longest7DaysSeconds?: number | null };
    codes?:
        | { error: string }
        | {
              days: {
                  day: string;
                  codes: number;
                  expiredUnused: number;
                  handled: number;
                  open: number;
                  migaduDelayed: number;
                  medianMinutesToFreshCode: number | null;
              }[];
              timeline: { stepMinutes: number; points: { at: string; waiting: number }[] };
          };
    database: { reachable: boolean; emails?: number };
    server: {
        disk: { totalBytes: number; usedBytes: number } | null;
        memory: { totalBytes: number; usedBytes: number };
        appStartedAt: string;
    };
    hot?: { error?: string; enabled: boolean; watchingNow: number; checksThisHour: number; recoveredThisHour: number };
    sweep?: { error?: string; enabled: boolean; roundHours: number; mailboxes: number; sweptThisRound: number };
    // Newest 100, open problems first. solved/info rows are shown greyed.
    recent: {
        at: string;
        what: string;
        details: string;
        state: "open" | "solved" | "info";
        solvedAt: string | null;
        times?: number;
        firstAt?: string;
    }[];
}

export async function fetchSystemStatus(): Promise<SystemStatus> {
    const res = await apiFetch(`${API_BASE}/api/status`, { credentials: "include" });

    if (!res.ok) {
        throw new Error(`Could not load status (${res.status})`);
    }

    return res.json();
}
