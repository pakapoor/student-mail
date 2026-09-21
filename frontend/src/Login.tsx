import { useState } from "react";
import { login } from "./api";
import type { College, Session } from "./types";

interface Props {
    college: College;
    onChangeCollege: () => void;
    onLoggedIn: (session: Session) => void;
}

export default function Login({ college, onChangeCollege, onLoggedIn }: Props) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setSubmitting(true);

        try {
            const session = await login(email, password, college.id);
            onLoggedIn(session);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Login failed");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="login-page">
            <form className="login-card" onSubmit={handleSubmit}>
                <p className="brand-name">ISM Edutech</p>
                <h1>{college.name}</h1>
                <p className="login-subtitle">
                    Sign in with your central mailbox address and password.
                </p>
                <button type="button" className="change-college" onClick={onChangeCollege} disabled={submitting}>
                    ← Change college
                </button>

                <label className="login-field">
                    <span>Central email</span>
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="central.ksma@myemailinfo.com"
                        autoComplete="username"
                        disabled={submitting}
                        required
                    />
                </label>

                <label className="login-field">
                    <span>Password</span>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        disabled={submitting}
                        required
                    />
                </label>

                {error && <p className="error">{error}</p>}

                <button className="send-button" type="submit" disabled={submitting}>
                    {submitting && <span className="spinner" />}
                    {submitting ? "Signing in..." : "Sign in"}
                </button>
            </form>
        </div>
    );
}
