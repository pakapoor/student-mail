import type {
    College,
    Session,
    AdminStudentPage,
    ImportResult,
    StatusFilter,
    StudentRow,
    ThreadItem,
    ThreadSummary,
} from "./types";

// Must match the page's hostname (not just resolve to the same machine) -
// SameSite=Lax cookies are dropped on cross-site fetches, and browsers treat
// "localhost" and "127.0.0.1" as different sites even though both are local.
// In production, Nginx reverse-proxies /api on the same origin as the page,
// so VITE_API_BASE is set to "" at build time (see frontend/.env.production).
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3001";

export interface ThreadSummaryPage {
    threads: ThreadSummary[];
    total: number;
    hasMore: boolean;
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
    const res = await fetch(`${API_BASE}/api/auth/college`, {
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
    search?: string
): Promise<ThreadSummaryPage> {
    const searchParam = search?.trim() ? `&search=${encodeURIComponent(search.trim())}` : "";
    const res = await fetch(
        `${API_BASE}/api/threads?status=${status}&limit=${limit}&offset=${offset}${searchParam}`,
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
    const res = await fetch(
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
        const res = await fetch(`${API_BASE}/api/check-mail/${studentId}`, {
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
    const res = await fetch(`${API_BASE}/api/messages/${id}/thread`, {
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

export function subscribeToUpdates(onUpdate: (event: UpdateEvent) => void): () => void {
    const source = new EventSource(`${API_BASE}/api/events`, {
        withCredentials: true,
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
    return () => source.close();
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

    const res = await fetch(`${API_BASE}/api/messages/${id}/reply`, {
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

    const res = await fetch(`${API_BASE}/api/messages/${id}/follow-up`, {
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
    const res = await fetch(`${API_BASE}/api/students`, {
        credentials: "include",
    });

    if (!res.ok) {
        throw new Error(`Failed to load students (${res.status})`);
    }

    return res.json();
}

export async function importStudents(csv: string): Promise<ImportResult> {
    const res = await fetch(`${API_BASE}/api/students/import`, {
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
    deleted: boolean,
    registrationPendingOnly = false
): Promise<AdminStudentPage> {
    const params = new URLSearchParams();

    if (registrationPendingOnly) {
        params.set("registration", "pending");
    }

    if (search) {
        params.set("search", search);
    }

    if (cursor) {
        params.set("cursor", cursor);
    }

    if (deleted) {
        params.set("deleted", "true");
    }

    const res = await fetch(`${API_BASE}/api/admin/students?${params}`, {
        credentials: "include",
    });

    if (!res.ok) {
        throw new Error(`Failed to load students (${res.status})`);
    }

    return res.json();
}

export async function fetchPendingCounts(
    ids: number[]
): Promise<Record<number, number>> {
    const res = await fetch(`${API_BASE}/api/admin/students/pending-counts`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
    });

    if (!res.ok) {
        throw new Error(`Failed to load pending counts (${res.status})`);
    }

    return res.json();
}

export async function deleteStudents(
    ids: number[]
): Promise<{ deleted: number }> {
    const res = await fetch(`${API_BASE}/api/admin/students/delete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
    });

    const payload = await res.json();

    if (!res.ok) {
        throw new Error(payload.error || `Delete failed (${res.status})`);
    }

    return payload;
}

export async function restoreStudent(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/api/admin/students/${id}/restore`, {
        method: "POST",
        credentials: "include",
    });

    if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Restore failed (${res.status})`);
    }
}

export async function markHandled(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/api/messages/${id}/mark-handled`, {
        method: "POST",
        credentials: "include",
    });

    if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to mark as handled (${res.status})`);
    }
}
