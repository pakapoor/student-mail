// fetch for calls that need a login. A 401 means the session is gone - for
// example it was signed out in another browser tab, which shares the cookie -
// so the app is told once and can show the Login screen, instead of every
// call failing with its own "(401)" error. Kept free of browser-only imports
// so the backend test runner can exercise it.

let onSessionEnded: (() => void) | null = null;

// The app registers what to do when the session has ended; returns an
// unregister function.
export function setSessionEndedHandler(handler: (() => void) | null): () => void {
    onSessionEnded = handler;
    return () => {
        if (onSessionEnded === handler) onSessionEnded = null;
    };
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(input, init);

    if (res.status === 401) {
        onSessionEnded?.();
    }

    return res;
}
