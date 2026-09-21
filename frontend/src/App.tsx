import { useEffect, useState } from "react";
import "./App.css";
import { fetchCurrentSession } from "./api";
import Login from "./Login";
import Console from "./Console";
import CollegePicker from "./CollegePicker";
import type { College, Session } from "./types";

function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [college, setCollege] = useState<College | null>(null);
    const [sessionError, setSessionError] = useState(false);
    const [checkingSession, setCheckingSession] = useState(true);

    useEffect(() => {
        fetchCurrentSession()
            .then(setSession)
            .catch(() => setSessionError(true))
            .finally(() => setCheckingSession(false));
    }, []);

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
        if (!college) return <CollegePicker onSelect={setCollege} />;
        return <Login college={college} onChangeCollege={() => setCollege(null)} onLoggedIn={setSession} />;
    }

    return <Console email={session.email} college={session.college} onLoggedOut={() => {
        setSession(null);
        setCollege(null);
    }} />;
}

export default App;
