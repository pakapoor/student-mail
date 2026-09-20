import { useEffect, useState } from "react";
import "./App.css";
import { fetchCurrentSession } from "./api";
import Login from "./Login";
import Console from "./Console";

function App() {
    const [email, setEmail] = useState<string | null>(null);
    const [checkingSession, setCheckingSession] = useState(true);

    useEffect(() => {
        fetchCurrentSession()
            .then(setEmail)
            .finally(() => setCheckingSession(false));
    }, []);

    if (checkingSession) {
        return <div className="app-loading">Loading...</div>;
    }

    if (!email) {
        return <Login onLoggedIn={setEmail} />;
    }

    return <Console email={email} onLoggedOut={() => setEmail(null)} />;
}

export default App;
