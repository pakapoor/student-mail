import { useEffect, useState } from "react";
import { fetchSystemStatus, type SystemStatus } from "./api";
import { shortDateTime } from "./format";
import ExpiredCodesChart from "./ExpiredCodesChart";

// System status page at /status (Step 21). Not linked from the staff
// screens; needs the normal console login. Refreshes every 30 s. No alert
// emails - the user checks this page when they want (their choice).

function ago(iso: string | null | undefined): string {
    if (!iso) {
        return "never";
    }

    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));

    if (seconds < 60) {
        return `${seconds} s ago`;
    }

    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

function duration(seconds: number | null | undefined): string {
    if (seconds == null) {
        return "—";
    }

    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function bytes(n: number | undefined): string {
    if (n == null) {
        return "—";
    }

    return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad"; children: React.ReactNode }) {
    return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <>
            <span>{label}</span>
            <b>{value}</b>
        </>
    );
}

export default function StatusPage() {
    const [status, setStatus] = useState<SystemStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;

        async function load() {
            try {
                const s = await fetchSystemStatus();
                if (alive) {
                    setStatus(s);
                    setError(null);
                }
            } catch (err) {
                if (alive) {
                    setError(err instanceof Error ? err.message : "Could not load status");
                }
            }
        }

        load();
        const timer = setInterval(load, 30000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, []);

    if (!status) {
        return (
            <div className="status-page">
                <div className="status-bar">
                    <h1>System status</h1>
                </div>
                <p className="empty-state">{error ?? "Loading…"}</p>
            </div>
        );
    }

    const s = status;
    const mailboxes = s.sync.mailboxes;
    // Same rule as the backend: no sync yet since a restart only counts as
    // overdue 10 min after the app started.
    const syncStale = mailboxes.some((mailbox) => new Date(s.generatedAt).getTime() - new Date(mailbox.lastSuccessAt ?? s.server.appStartedAt).getTime() > 10 * 60 * 1000);
    const syncConnected = mailboxes.length > 0 && mailboxes.every((mailbox) => mailbox.connected);
    const hot = s.hot;
    const sweep = s.sweep;
    const diskPct = s.server.disk ? Math.round((s.server.disk.usedBytes / s.server.disk.totalBytes) * 100) : null;
    const sweepPct = sweep && sweep.mailboxes > 0 ? Math.round((sweep.sweptThisRound / sweep.mailboxes) * 100) : 0;
    const codes = s.codes && !("error" in s.codes) ? s.codes : null;
    const waitingNow = codes?.timeline.points.at(-1)?.waiting ?? 0;

    return (
        <div className="status-page">
            <div className="status-bar">
                <h1>System status</h1>
                <small>
                    Updated {shortDateTime(s.generatedAt)} · refreshes every 30 s ·{" "}
                    <a href="/">back to the console</a>
                </small>
            </div>

            <div className="status-content">
                {error && <p className="status-refresh-error" role="alert">Refresh failed. Showing the last successful snapshot from {shortDateTime(s.generatedAt)}. Retrying automatically.</p>}
                <div className={`status-overall ${s.overall}`}>
                    <div className="status-overall-icon">{s.overall === "ok" ? "✓" : "!"}</div>
                    <div>
                        <b>
                            {s.overall === "ok"
                                ? "All systems working"
                                : s.overall === "warning"
                                  ? "Service needs attention"
                                  : "Service issue detected"}
                        </b>
                        {s.problems.concat(s.warnings).length === 0 ? (
                            <span>Mail is arriving and being processed normally.</span>
                        ) : (
                            <ul>
                                {s.problems.map((p) => (
                                    <li key={p} className="bad">{p}</li>
                                ))}
                                {s.warnings.map((w) => (
                                    <li key={w}>{w}</li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>

                <p className="status-hint" role="note">
                    Recovery, retry, and mailbox-failure counts are approximate: they use up to {s.activityCoverage?.maxEvents ?? 500} recent activity events from the last 24 hours and reset when the app restarts.
                    {s.activityCoverage && <> Activity window starts {shortDateTime(s.activityCoverage.since)}.</>}
                    {" "}Email and delivery-delay totals labelled “today” come from the database.
                </p>
                <div className="status-grid">
                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Central mailbox sync</b>
                            {syncStale || mailboxes.length === 0 ? <Pill tone="bad">Sync overdue</Pill> : syncConnected ? <Pill tone="ok">Healthy</Pill> : <Pill tone="warn">Reconnecting</Pill>}
                        </div>
                        <div className="status-kv">
                            {mailboxes.map((mailbox) => <Row key={mailbox.email} label={mailbox.email} value={<>{mailbox.connected ? "Connected" : "Disconnected"}<br /><small>Synced {ago(mailbox.lastSuccessAt)}</small></>} />)}
                            <Row label="Emails received today" value={s.sync.emailsToday} />
                        </div>
                        <p className="status-hint">A problem if no sync succeeds for 10 min.</p>
                    </div>

                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Hot list</b>
                            {!hot || hot.error ? <Pill tone="warn">Unavailable</Pill> : hot.enabled ? <Pill tone="ok">Enabled</Pill> : <Pill tone="warn">Off</Pill>}
                        </div>
                        <div className="status-kv">
                            <Row label="Students being watched now" value={hot?.watchingNow ?? "—"} />
                            <Row label="Checks in current hourly window" value={hot?.checksThisHour ?? "—"} />
                            <Row label="Recovered emails (approx.)" value={s.recoveredToday.hot} />
                        </div>
                        <p className="status-hint">Students waiting for a registration email after a code.</p>
                    </div>

                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Daily sweep</b>
                            {!sweep || sweep.error ? <Pill tone="warn">Unavailable</Pill> : sweep.enabled ? <Pill tone="ok">Enabled</Pill> : <Pill tone="warn">Off</Pill>}
                        </div>
                        <div className="status-meter">
                            <i style={{ width: `${sweepPct}%` }} />
                        </div>
                        <div className="status-kv">
                            <Row label="Attempted in rolling window" value={sweep && !sweep.error ? `${sweep.sweptThisRound} / ${sweep.mailboxes} mailboxes` : "—"} />
                            <Row label="Recovered emails (approx.)" value={s.recoveredToday.sweep} />
                            <Row label="Failed mailbox checks (approx.)" value={s.mailboxFailures24h} />
                        </div>
                        <p className="status-hint">Counts include failed attempts in the last {sweep?.roundHours ?? 24} hours. Review failures below.</p>
                    </div>

                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Emails fetched without content</b>
                            {s.retries.gaveUpToday > 0 ? <Pill tone="warn">{s.retries.gaveUpToday} given up</Pill> : <Pill tone="ok">OK</Pill>}
                        </div>
                        <div className="status-kv">
                            <Row label="Retries (approx.)" value={s.retries.retriedToday} />
                            <Row label="Given up (approx.)" value={s.retries.gaveUpToday} />
                            <Row label="Recovered by search (approx.)" value={s.recoveredToday.search} />
                        </div>
                        <p className="status-hint">Migadu sometimes serves a new email empty; it's retried a few seconds later.</p>
                    </div>

                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Migadu delivery delays</b>
                            {(s.delays.heldOver5MinToday ?? 0) > 0 ? (
                                <Pill tone="warn">{s.delays.heldOver5MinToday} today</Pill>
                            ) : (
                                <Pill tone="ok">None today</Pill>
                            )}
                        </div>
                        <div className="status-kv">
                            <Row label="Emails held > 5 min today" value={s.delays.heldOver5MinToday ?? 0} />
                            <Row label="Longest hold today" value={duration(s.delays.longestTodaySeconds)} />
                            <Row label="Longest hold, last 7 days" value={duration(s.delays.longest7DaysSeconds)} />
                        </div>
                        <p className="status-hint">Held by Migadu before reaching any mailbox. Queue IDs below, for Migadu support.</p>
                    </div>

                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Server</b>
                            {diskPct !== null && diskPct > 90 ? <Pill tone="bad">Disk full</Pill> : <Pill tone="ok">Healthy</Pill>}
                        </div>
                        <div className="status-kv">
                            <Row
                                label="Disk used"
                                value={s.server.disk ? `${bytes(s.server.disk.usedBytes)} of ${bytes(s.server.disk.totalBytes)} (${diskPct}%)` : "—"}
                            />
                            <Row label="Memory used" value={`${bytes(s.server.memory.usedBytes)} of ${bytes(s.server.memory.totalBytes)}`} />
                            <Row label="App running since" value={shortDateTime(s.server.appStartedAt)} />
                            <Row label="Database" value={s.database.reachable ? `Reachable · ${s.database.emails} emails` : "Not reachable"} />
                        </div>
                    </div>
                </div>

                {/* Step 27: verification codes that expired unused. */}
                <div className="status-card">
                    <div className="status-card-head">
                        <b>Expired codes</b>
                        {!codes ? (
                            <Pill tone="warn">Unavailable</Pill>
                        ) : waitingNow > 0 ? (
                            <Pill tone="warn">{waitingNow} waiting now</Pill>
                        ) : (
                            <Pill tone="ok">None waiting</Pill>
                        )}
                    </div>
                    {codes && (
                        <>
                            <p className="status-hint">Waiting for a fresh code, every 5 min over the last 6 h.</p>
                            <ExpiredCodesChart points={codes.timeline.points} />
                            <div className="status-table-wrap">
                                <table className="status-table codes-days">
                                    <thead>
                                        <tr>
                                            <th>Day</th>
                                            <th>Codes</th>
                                            <th>Expired unused</th>
                                            <th>Handled</th>
                                            <th>Median time to fresh code</th>
                                            <th>Still waiting</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {[...codes.days].reverse().map((d) => (
                                            <tr key={d.day}>
                                                <td className="t">{new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</td>
                                                <td>{d.codes}</td>
                                                <td>
                                                    {d.expiredUnused}
                                                    {d.migaduDelayed > 0 && <small> ({d.migaduDelayed} Migadu delay)</small>}
                                                </td>
                                                <td>{d.handled}</td>
                                                <td>{d.medianMinutesToFreshCode === null ? "—" : `${d.medianMinutesToFreshCode} min`}</td>
                                                <td>{d.open}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <p className="status-hint">Handled = a fresh code arrived. Migadu delay = the code email itself was held over 5 min.</p>
                        </>
                    )}
                </div>

                <div className="status-card">
                    <div className="status-card-head">
                        <b>Recent problems</b>
                        <span className="status-hint">last 24 h</span>
                    </div>
                    {s.recent.length === 0 ? (
                        <p className="empty-state">No problems in the last 24 hours.</p>
                    ) : (
                        <div className="status-table-wrap">
                            <table className="status-table">
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>What</th>
                                        <th>Details</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {s.recent.map((r, i) => (
                                        <tr key={`${r.at}-${i}`}>
                                            <td className="t">{shortDateTime(r.at)}</td>
                                            <td>{r.what}</td>
                                            <td>{r.details}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
