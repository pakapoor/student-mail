import { useEffect, useState } from "react";

// Keeps open consoles on the latest deployed build. A tab left open across a
// deploy keeps running the old JavaScript against the new backend - after the
// Step 16 follow-up deploy that silently broke the mailbox check until a
// manual reload. So: every minute (and whenever the tab regains focus) fetch
// index.html and compare the hashed bundle name Vite put in it with the one
// this page loaded. If they differ, a newer build is live.

const CHECK_INTERVAL_MS = 60 * 1000;
const BUNDLE_PATTERN = /\/assets\/index-[\w-]+\.js/;

function loadedBundle(): string | null {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
    const match = script?.getAttribute("src")?.match(BUNDLE_PATTERN);
    return match ? match[0] : null;
}

async function latestBundle(): Promise<string | null> {
    try {
        const res = await fetch("/", { cache: "no-store" });

        if (!res.ok) {
            return null;
        }

        const match = (await res.text()).match(BUNDLE_PATTERN);
        return match ? match[0] : null;
    } catch {
        return null;
    }
}

// Returns true once a newer build than the running one has been deployed.
// Never true in `npm run dev`, which has no hashed bundle to compare.
export function useNewVersionAvailable(): boolean {
    const [available, setAvailable] = useState(false);

    useEffect(() => {
        const current = loadedBundle();

        if (!current || available) {
            return;
        }

        async function check() {
            const latest = await latestBundle();

            if (latest && latest !== current) {
                setAvailable(true);
            }
        }

        function onVisible() {
            if (document.visibilityState === "visible") {
                check();
            }
        }

        const timer = setInterval(check, CHECK_INTERVAL_MS);
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", check);

        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", check);
        };
    }, [available]);

    return available;
}

// The search box survives the automatic reload, so an operator mid-lookup
// doesn't lose their place. Session storage can be unavailable (privacy
// modes) - then the reload simply starts with an empty search.
const SEARCH_KEY = "student-mail:search-before-reload";

export function saveSearchForReload(search: string) {
    try {
        sessionStorage.setItem(SEARCH_KEY, search);
    } catch {
        // Not critical.
    }
}

export function takeSearchSavedForReload(): string {
    try {
        const value = sessionStorage.getItem(SEARCH_KEY) ?? "";
        sessionStorage.removeItem(SEARCH_KEY);
        return value;
    } catch {
        return "";
    }
}
