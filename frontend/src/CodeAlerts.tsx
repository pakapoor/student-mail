import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCodeAlerts, type CodeAlert } from "./api";

// Code expiry alerts (Step 27): up to 2 rows in the empty space right of the
// search box, above the email pane. Amber = a code in its last 5 minutes,
// red = expired unused (which ones: backend codeAlerts.ts). More than 2 →
// they roll up one row every 4 s, pausing under the mouse. Clicking a row
// opens that student's thread.

const VISIBLE = 2;
const ROLL_EVERY_MS = 4000;
// Row height + gap (App.css .code-alert / .code-alerts-track).
const ROW_STEP_PX = 33;
const REFRESH_MS = 60 * 1000;
const TICK_MS = 15 * 1000;
const MIN_MS = 60 * 1000;

function minutesText(ms: number): string {
    const minutes = Math.floor(ms / MIN_MS);

    if (minutes < 60) {
        return `${Math.max(minutes, 0)} min`;
    }

    const hours = Math.floor(minutes / 60);
    return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

function alertText(alert: CodeAlert, expired: boolean, now: number): string {
    const expiresAt = new Date(alert.expiresAt).getTime();

    if (!expired) {
        return `expires in ${minutesText(expiresAt - now + MIN_MS - 1)}`;
    }

    return now - expiresAt < MIN_MS
        ? "expired just now · get fresh code"
        : `expired ${minutesText(now - expiresAt)} ago · get fresh code`;
}

interface Props {
    // Bumped by the console on every live update, so new codes show at once.
    refreshKey: number;
    onOpen: (messageId: number) => void;
    onShowOlder: () => void;
}

export default function CodeAlerts({ refreshKey, onOpen, onShowOlder }: Props) {
    const [alerts, setAlerts] = useState<CodeAlert[]>([]);
    const [olderExpired, setOlderExpired] = useState(0);
    // Server clock minus this PC's clock, so countdowns are right even when
    // the PC's clock is off.
    const [clockOffset, setClockOffset] = useState(0);
    const [now, setNow] = useState(() => Date.now());
    const [rollIndex, setRollIndex] = useState(0);
    const [jump, setJump] = useState(false);
    const [paused, setPaused] = useState(false);
    const request = useRef(0);
    const [reduceMotion] = useState(
        () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
    );

    const load = useCallback(async () => {
        const seq = ++request.current;

        try {
            const result = await fetchCodeAlerts();

            if (seq !== request.current) {
                return;
            }

            setAlerts(result.alerts);
            setOlderExpired(result.olderExpired);
            setClockOffset(new Date(result.serverNow).getTime() - Date.now());
            setNow(Date.now());
        } catch {
            // Keep the last rows; the next refresh tries again. Logging out
            // is handled by the console's live-update connection.
        }
    }, []);

    useEffect(() => {
        load();
    }, [load, refreshKey]);

    useEffect(() => {
        const refresh = setInterval(load, REFRESH_MS);
        const tick = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => {
            clearInterval(refresh);
            clearInterval(tick);
        };
    }, [load]);

    // An amber code turns red the moment it expires, without waiting for the
    // next refresh. Which red rows to show (30 min / 24 h) is the server's call.
    const serverNow = now + clockOffset;
    const rows = alerts
        .map((alert) => ({ alert, expired: alert.state === "expired" || new Date(alert.expiresAt).getTime() <= serverNow }))
        .sort((a, b) => Number(a.expired) - Number(b.expired));
    const rolls = rows.length > VISIBLE && !reduceMotion;
    const signature = rows.map((r) => `${r.alert.messageId}:${r.expired}`).join(",");

    // New set of rows → start again from the top.
    useEffect(() => {
        setJump(true);
        setRollIndex(0);
    }, [signature]);

    useEffect(() => {
        if (!rolls || paused) {
            return;
        }

        const timer = setInterval(() => {
            setJump(false);
            setRollIndex((i) => i + 1);
        }, ROLL_EVERY_MS);
        return () => clearInterval(timer);
    }, [rolls, paused]);

    // Past the last row the first two are repeated; once they're in place,
    // snap back to the top without animation (looks seamless).
    useEffect(() => {
        if (rollIndex < rows.length || !rolls) {
            return;
        }

        const timer = setTimeout(() => {
            setJump(true);
            setRollIndex(0);
        }, 550);
        return () => clearTimeout(timer);
    }, [rollIndex, rows.length, rolls]);

    if (rows.length === 0 && olderExpired === 0) {
        return null;
    }

    const hiddenByNoMotion = !rolls && rows.length > VISIBLE ? rows.length - VISIBLE : 0;
    const track = rolls ? rows.concat(rows.slice(0, VISIBLE)) : rows.slice(0, VISIBLE);

    return (
        <div
            className="code-alerts"
            role="status"
            aria-label="Verification code alerts"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
        >
            <div className="code-alerts-count">
                {rolls && <span>{rows.length} code alerts</span>}
                {hiddenByNoMotion > 0 && <span>+{hiddenByNoMotion} more</span>}
                {olderExpired > 0 && (
                    <button type="button" className="code-alerts-older" onClick={onShowOlder}>
                        +{olderExpired} older expired
                    </button>
                )}
            </div>
            {rows.length > 0 && (
                <div className="code-alerts-window" style={{ height: Math.min(rows.length, VISIBLE) * ROW_STEP_PX - 4 }}>
                    <div
                        className={jump ? "code-alerts-track jump" : "code-alerts-track"}
                        style={{ transform: `translateY(-${rollIndex * ROW_STEP_PX}px)` }}
                    >
                        {track.map(({ alert, expired }, i) => (
                            <button
                                type="button"
                                key={`${alert.messageId}-${i}`}
                                className={expired ? "code-alert expired" : "code-alert expiring"}
                                onClick={() => onOpen(alert.messageId)}
                                // The repeated rows are only there for the loop.
                                tabIndex={i >= rows.length ? -1 : undefined}
                                aria-hidden={i >= rows.length ? true : undefined}
                            >
                                <span className="code-alert-dot" aria-hidden="true" />
                                <span className="code-alert-text">
                                    <strong>{alert.name ?? alert.email}</strong>
                                    {alert.appNo && <span className="code-alert-appno"> {alert.appNo}</span>}
                                    {" · "}
                                    {alertText(alert, expired, serverNow)}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
