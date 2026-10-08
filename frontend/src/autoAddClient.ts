// The browser's call to POST /api/students/auto-add, kept free of browser-only
// imports so the backend test runner can exercise it (like apiFetch.ts).
// Whatever goes wrong - the server cut off by nginx (an HTML page, not JSON), a
// server that never answers, a dropped connection - the clerk gets one plain
// sentence instead of a raw parsing error, and a row can never stay on
// "Trying to add" for ever.

import { apiFetch } from "./apiFetch";
import type { AutoAddResult } from "./types";
import type { TakenNumber } from "./studentLines";

// A line normally takes about a second and nginx cuts a request at 60 s.
export const AUTO_ADD_TIMEOUT_MS = 45000;

export async function postAutoAdd(url: string, csv: string, timeoutMs: number = AUTO_ADD_TIMEOUT_MS): Promise<AutoAddResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        let res: Response;

        try {
            res = await apiFetch(url, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ csv }),
                signal: controller.signal,
            });
        } catch {
            throw new Error(
                controller.signal.aborted
                    ? "The server did not answer in time. Wait a moment and try again."
                    : "Could not reach the server. Check the internet connection and try again."
            );
        }

        let payload: unknown = null;

        try {
            payload = await res.json();
        } catch {
            // Not JSON (for example an error page from the proxy) - handled below.
        }

        if (!res.ok) {
            const message =
                payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
                    ? payload.error
                    : null;

            if (message) {
                throw new Error(message);
            }

            if (res.status === 401) {
                throw new Error("You have been signed out. Log in again.");
            }

            if (res.status === 502 || res.status === 503 || res.status === 504) {
                throw new Error("The server is busy or restarting. Wait a moment and try again.");
            }

            throw new Error(`Adding students failed (${res.status}). Try again.`);
        }

        if (!payload || typeof payload !== "object" || !("rows" in payload)) {
            throw new Error("The server sent an answer that could not be read. Try again.");
        }

        return payload as AutoAddResult;
    } finally {
        clearTimeout(timer);
    }
}

// Which of these Application Nos are already used in the college. This is only
// advice for the screen, so it fails quietly: on any problem the answer is
// "nothing known" and adding goes ahead (the server checks again).
export async function postCheckNumbers(url: string, numbers: string[], timeoutMs = 8000): Promise<Record<string, TakenNumber>> {
    if (numbers.length === 0) {
        return {};
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await apiFetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ numbers }),
            signal: controller.signal,
        });

        if (!res.ok) {
            return {};
        }

        const payload: unknown = await res.json();
        const used = payload && typeof payload === "object" && "used" in payload ? payload.used : null;
        return used && typeof used === "object" ? (used as Record<string, TakenNumber>) : {};
    } catch {
        return {};
    } finally {
        clearTimeout(timer);
    }
}
