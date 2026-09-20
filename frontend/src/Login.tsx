import { useState } from "react";
import { login } from "./api";

interface Props {
    onLoggedIn: (email: string) => void;
}

export default function Login({ onLoggedIn }: Props) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setSubmitting(true);

        try {
            const loggedInEmail = await login(email, password);
            onLoggedIn(loggedInEmail);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Login failed");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="login-page">
            <form className="login-card" onSubmit={handleSubmit}>
                <h1>Student Mail Console</h1>
                <p className="login-subtitle">
                    Sign in with your central mailbox address and password. You will
                    only see students whose mail forwards to this mailbox.
                </p>

                <label className="login-field">
                    <span>Central email</span>
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="central1@system-design.in"
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
