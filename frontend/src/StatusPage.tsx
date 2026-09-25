import { useEffect, useState } from "react";
import { fetchSystemStatus, type SystemStatus } from "./api";
import { shortDateTime } from "./format";

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
    const mailbox = s.sync.mailboxes[0];
    const hot = s.hot;
    const sweep = s.sweep;
    const diskPct = s.server.disk ? Math.round((s.server.disk.usedBytes / s.server.disk.totalBytes) * 100) : null;
    const sweepPct = sweep && sweep.mailboxes > 0 ? Math.round((sweep.sweptThisRound / sweep.mailboxes) * 100) : 0;

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
                <div className={`status-overall ${s.overall}`}>
                    <div className="status-overall-icon">{s.overall === "ok" ? "✓" : "!"}</div>
                    <div>
                        <b>
                            {s.overall === "ok"
                                ? "All systems working"
                                : s.overall === "warning"
                                  ? "Working, with things to look at"
                                  : "Something is wrong"}
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

                <div className="status-grid">
                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Central mailbox sync</b>
                            {mailbox && mailbox.connected ? <Pill tone="ok">Healthy</Pill> : <Pill tone="warn">Reconnecting</Pill>}
                        </div>
                        <div className="status-kv">
                            <Row label={`Live connection to ${mailbox?.email ?? "central"}`} value={mailbox?.connected ? "Connected" : "Not connected"} />
                            <Row label="Last successful sync" value={ago(mailbox?.lastSuccessAt)} />
                            <Row label="Emails received today" value={s.sync.emailsToday} />
                        </div>
                        <p className="status-hint">A problem if no sync succeeds for 10 min.</p>
                    </div>

                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Hot list</b>
                            {hot?.enabled ? <Pill tone="ok">Running</Pill> : <Pill tone="warn">Off</Pill>}
                        </div>
                        <div className="status-kv">
                            <Row label="Students being watched now" value={hot?.watchingNow ?? 0} />
                            <Row label="Checks this hour" value={hot?.checksThisHour ?? 0} />
                            <Row label="Emails recovered today" value={s.recoveredToday.hot} />
                        </div>
                        <p className="status-hint">Students waiting for a registration email after a code.</p>
                    </div>

                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Daily sweep</b>
                            {sweep?.enabled ? <Pill tone="ok">Running</Pill> : <Pill tone="warn">Off</Pill>}
                        </div>
                        <div className="status-meter">
                            <i style={{ width: `${sweepPct}%` }} />
                        </div>
                        <div className="status-kv">
                            <Row label="This round" value={`${sweep?.sweptThisRound ?? 0} / ${sweep?.mailboxes ?? 0} mailboxes`} />
                            <Row label="Emails recovered today" value={s.recoveredToday.sweep} />
                            <Row label="Mailboxes that failed to open (24 h)" value={s.mailboxFailures24h} />
                        </div>
                        <p className="status-hint">Failures are usually wrong stored passwords - see below.</p>
                    </div>

                    <div className="status-card">
                        <div className="status-card-head">
                            <b>Emails fetched without content</b>
                            {s.retries.gaveUpToday > 0 ? <Pill tone="warn">{s.retries.gaveUpToday} given up</Pill> : <Pill tone="ok">OK</Pill>}
                        </div>
                        <div className="status-kv">
                            <Row label="Retried today" value={s.retries.retriedToday} />
                            <Row label="Given up today" value={s.retries.gaveUpToday} />
                            <Row label="Recovered by search today" value={s.recoveredToday.search} />
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
