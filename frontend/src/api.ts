import type {
    ImportResult,
    StatusFilter,
    StudentRow,
    ThreadItem,
    ThreadSummary,
} from "./types";

// Must match the page's hostname (not just resolve to the same machine) -
// SameSite=Lax cookies are dropped on cross-site fetches, and browsers treat
// "localhost" and "127.0.0.1" as different sites even though both are local.
const API_BASE = "http://localhost:3001";

export interface ThreadSummaryPage {
    threads: ThreadSummary[];
    total: number;
    hasMore: boolean;
}

const PAGE_SIZE = 25;

export async function login(email: string, password: string): Promise<string> {
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

    return payload.email;
}

export async function logout(): Promise<void> {
    await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
    });
}

export async function fetchCurrentSession(): Promise<string | null> {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
        credentials: "include",
    });

    if (!res.ok) {
        return null;
    }

    const payload = await res.json();
    return payload.email;
}

export async function fetchThreadSummaries(
    status: StatusFilter,
    offset = 0
): Promise<ThreadSummaryPage> {
    const res = await fetch(
        `${API_BASE}/api/threads?status=${status}&limit=${PAGE_SIZE}&offset=${offset}`,
        { credentials: "include" }
    );

    if (!res.ok) {
        throw new Error(`Failed to load threads (${res.status})`);
    }

    return res.json();
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

export function subscribeToUpdates(onUpdate: () => void): () => void {
    const source = new EventSource(`${API_BASE}/api/events`, {
        withCredentials: true,
    });
    source.addEventListener("update", () => onUpdate());
    return () => source.close();
}

export async function sendReply(
    id: number,
    body: string,
    attachments: File[]
): Promise<{ sent: true; sentMessageId: string }> {
    const formData = new FormData();
    formData.append("body", body);

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
