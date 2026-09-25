import { useEffect, useState } from "react";
import type { KeyInfo } from "./keyInfo";
import { edugateDate, shortDateTime } from "./format";
import { EDUGATE_LOGIN_URL, EDUGATE_REGISTER_URL } from "../../shared/edugate";

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

// Opens the Edugate portal's login page in a new tab - staff copy the
// login/password from the box, then paste them there.
function OpenEdugate({ href = EDUGATE_LOGIN_URL, label = "Open Edugate ↗" }: { href?: string; label?: string }) {
    return (
        <a className="key-info-open" href={href} target="_blank" rel="noopener noreferrer">
            {label}
        </a>
    );
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
    const receivedTime = shortDateTime(receivedAt);
    const expired = info.kind === "code" && ageMinutes >= info.validMinutes;
    // Registration email that may be outdated (Step 18 phase 2): a newer
    // registration exists, or a newer Edugate email we don't recognise yet
    // (e.g. a password reset).
    const newerLogin = info.kind === "login" ? info.item.newer_login_at : null;
    const newerEdugate = info.kind === "login" && !newerLogin ? info.item.newer_edugate_at : null;
    const dateTime = (iso: string) => shortDateTime(iso);

    // Rejected document: red, as a warning - someone has to act on it.
    if (info.kind === "rejected") {
        const login = info.item.edugate_login;

        return (
            <div className="key-info rejected">
                <div className="key-info-heading">
                    <span>❌ Document rejected</span>
                    <span className="key-info-source">received {receivedTime}</span>
                </div>
                <div className="key-info-row wide">
                    <span className="key-info-label">Document</span>
                    <span className="key-info-text">{info.document}</span>
                </div>
                {info.note && (
                    <div className="key-info-row wide">
                        <span className="key-info-label">
                            {info.noteKind === "action" ? "Action needed" : "Reason"}
                        </span>
                        <span className="key-info-text strong">{info.note}</span>
                    </div>
                )}
                <div className="key-info-row wide">
                    <span className="key-info-label">Reviewed</span>
                    <span className="key-info-text">{edugateDate(info.reviewedAt)}</span>
                </div>

                {/* Staff re-upload the document on Edugate, so the student's
                    login is right here (from their registration email). */}
                <div className="key-info-divider" />
                {login ? (
                    <>
                        <div className="key-info-row login">
                            <span className="key-info-label">Edugate login</span>
                            <span className="key-info-value small">{login.login}</span>
                            <CopyButton value={login.login} />
                        </div>
                        <div className="key-info-row login">
                            <span className="key-info-label">Password</span>
                            <span className="key-info-value">{login.password}</span>
                            <CopyButton value={login.password} />
                        </div>
                        <div className="key-info-footer">
                            <span className="key-info-source">
                                from the registration email of {dateTime(login.sent_at)}
                            </span>
                            <OpenEdugate />
                        </div>
                        {login.newer_edugate_at && (
                            <p className="key-info-warning">
                                ⚠ A newer Edugate email arrived on {dateTime(login.newer_edugate_at)}. Check it before using this password.
                            </p>
                        )}
                    </>
                ) : (
                    <p className="key-info-source">No Edugate login found for this student.</p>
                )}
            </div>
        );
    }

    return (
        <div className={expired || newerLogin ? "key-info expired" : "key-info"}>
            <p className="key-info-source">From the Edugate email received {receivedTime}</p>

            {info.kind === "code" ? (
                <>
                    <div className="key-info-row">
                        <span className="key-info-label">Code</span>
                        <span className="key-info-value">{info.code}</span>
                        {/* No Copy on an expired code - nobody should use it. */}
                        {!expired && <CopyButton value={info.code} />}
                    </div>
                    {expired ? (
                        <>
                            <p className="key-info-warning">
                                ⚠ Received {ageText(ageMinutes)}. This code has probably expired. Ask for a new code.
                            </p>
                            {/* A new code is requested on Edugate's registration page. */}
                            <div className="key-info-footer">
                                <span />
                                <OpenEdugate href={EDUGATE_REGISTER_URL} label="Request a new code ↗" />
                            </div>
                        </>
                    ) : (
                        <>
                            <p className="key-info-age">
                                Received {ageText(ageMinutes)} · Edugate codes are valid for {info.validMinutes} minutes
                            </p>
                            {/* Backend hot list checks the mailbox every 30 s,
                                then every 2 min, until the registration arrives. */}
                            <p className="waiting-registration">
                                ⏳ Watching the mailbox for the registration email…
                            </p>
                        </>
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
                    <div className="key-info-footer">
                        <span />
                        <OpenEdugate />
                    </div>
                    {newerLogin && (
                        <p className="key-info-warning">
                            ⚠ A newer login was sent on {dateTime(newerLogin)}. Use that one.
                        </p>
                    )}
                    {newerEdugate && (
                        <p className="key-info-warning">
                            ⚠ A newer Edugate email arrived on {dateTime(newerEdugate)}. Check it before using this password.
                        </p>
                    )}
                </>
            )}
        </div>
    );
}
