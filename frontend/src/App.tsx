import { useEffect, useState } from "react";
import "./App.css";
import { fetchCurrentSession } from "./api";
import { setSessionEndedHandler } from "./apiFetch";
import Login from "./Login";
import Console from "./Console";
import CollegePicker from "./CollegePicker";
import StatusPage from "./StatusPage";
import type { Session } from "./types";

function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [sessionError, setSessionError] = useState(false);
    const [checkingSession, setCheckingSession] = useState(true);

    useEffect(() => {
        fetchCurrentSession()
            .then(setSession)
            .catch(() => setSessionError(true))
            .finally(() => setCheckingSession(false));
    }, []);

    // Any logged-in call that gets a 401 (e.g. signed out in another tab)
    // sends the user to the Login screen instead of showing an error.
    useEffect(() => setSessionEndedHandler(() => setSession(null)), []);

    if (checkingSession) {
        return <div className="app-loading">Loading...</div>;
    }

    if (sessionError) {
        return <div className="login-page"><div className="login-card">
            <p role="alert">Unable to connect. Please try again.</p>
            <button className="send-button" onClick={() => window.location.reload()}>Retry</button>
        </div></div>;
    }

    if (!session) {
        return <Login onLoggedIn={setSession} />;
    }

    // System status page (Step 21): /status, after login, no college
    // needed. Not linked from the staff screens.
    if (window.location.pathname === "/status") {
        return <StatusPage />;
    }

    if (!session.college) {
        return <CollegePicker onSelect={setSession} />;
    }

    return <Console college={session.college} onLoggedOut={() => {
        setSession(null);
    }} />;
}

export default App;
