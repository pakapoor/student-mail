import { useEffect, useState } from "react";
import type { KeyInfo } from "./keyInfo";

// The box at the top of an opened thread (see keyInfo.ts). Always English,
// whatever language the email is in - only the values come from the email.

function ageText(minutes: number): string {
    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h ago` : `${hours} h ${rest} min ago`;
}

function CopyButton({ value }: { value: string }) {
    const [copied, setCopied] = useState(false);

    async function copy() {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard blocked (e.g. plain http) - the value is still on
            // screen and selectable.
        }
    }

    return (
        <button type="button" className="key-info-copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
        </button>
    );
}

export default function KeyInfoBox({ info }: { info: KeyInfo }) {
    // Re-render every 30s so the age and the expiry warning stay current
    // while the thread is open.
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
    }, []);

    const receivedAt = new Date(info.item.at);
    const ageMinutes = Math.max(0, Math.floor((now - receivedAt.getTime()) / 60000));
    const receivedTime = receivedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const expired = info.kind === "code" && ageMinutes >= info.validMinutes;

    return (
        <div className={expired ? "key-info expired" : "key-info"}>
            <p className="key-info-source">From the Edugate email received {receivedTime}</p>

            {info.kind === "code" ? (
                <>
                    <div className="key-info-row">
                        <span className="key-info-label">Code</span>
                        <span className="key-info-value">{info.code}</span>
                        <CopyButton value={info.code} />
                    </div>
                    {expired ? (
                        <p className="key-info-warning">
                            ⚠ Received {ageText(ageMinutes)}. This code has probably expired. Ask for a new code.
                        </p>
                    ) : (
                        <p className="key-info-age">
                            Received {ageText(ageMinutes)} · Edugate codes are valid for {info.validMinutes} minutes
                        </p>
                    )}
                </>
            ) : (
                <>
                    <div className="key-info-row">
                        <span className="key-info-label">Login</span>
                        <span className="key-info-value small">{info.login}</span>
                        <CopyButton value={info.login} />
                    </div>
                    <div className="key-info-row">
                        <span className="key-info-label">Password</span>
                        <span className="key-info-value">{info.password}</span>
                        <CopyButton value={info.password} />
                    </div>
                </>
            )}
        </div>
    );
}
