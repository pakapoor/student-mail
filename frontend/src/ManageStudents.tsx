import { useCallback, useEffect, useRef, useState } from "react";
import { shortDateTime } from "./format";
import { autoAddStudents, fetchAdminStudents, fetchColleges, fetchStudents } from "./api";
import type {
    AdminStudentPage,
    AdminStudentRow,
    AutoAddResult,
    College,
    RosterFilter,
    StudentRow,
} from "./types";

interface Props {
    collegeName: string;
    onClose: () => void;
    onImported: () => void;
}

type RosterTab = "students" | "add";

// Edugate registration status (backend registrationStatus.ts).
// Same bucket as the filter buttons (backend studentsAdmin.ts): the
// student's latest Edugate event decides. A later code or rejection for a
// registered student keeps a "registered" note, since the account exists.
function RegistrationStatus({ s }: { s: AdminStudentRow }) {
    const registeredNote = s.registered_at && s.edugate_state !== "registered" && (
        <span className="reg-status-note">registered {shortDateTime(s.registered_at)}</span>
    );

    switch (s.edugate_state) {
        case "rejected":
            return (
                <span className="admin-cell admin-status">
                    <span className="reg-status rejected">Rejected · {shortDateTime(s.rejected_at!)}</span>
                    {registeredNote}
                </span>
            );
        case "registered":
            return (
                <span className="admin-cell admin-status">
                    <span className="reg-status registered">Registered · {shortDateTime(s.registered_at!)}</span>
                </span>
            );
        case "code_live":
        case "code_expired":
            return (
                <span className="admin-cell admin-status">
                    <span className={`reg-status ${s.edugate_state === "code_live" ? "pending" : "expired"}`}>
                        {s.edugate_state === "code_live" ? "Code received" : "Code expired"} · {shortDateTime(s.code_sent_at!)}
                    </span>
                    {registeredNote}
                </span>
            );
        default:
            return <span className="admin-cell admin-status muted">—</span>;
    }
}

// College buttons over the roster (Step 30): All colleges (default) or one.
// Counts are for the current search and ignore the pressed status button.
function CollegeButtons({
    colleges,
    college,
    counts,
    onChange,
}: {
    colleges: College[];
    college: string | null;
    counts: AdminStudentPage["collegeCounts"] | null;
    onChange: (college: string | null) => void;
}) {
    return (
        <div className="filter-row">
            <span className="filter-label" id="college-filter-label">College</span>
            <div className="filter-buttons" role="group" aria-labelledby="college-filter-label">
                <button
                    type="button"
                    className={college === null ? "filter-chip college active" : "filter-chip college"}
                    aria-pressed={college === null}
                    onClick={() => onChange(null)}
                >
                    All
                    {counts && <span className="filter-count">{counts.all ?? 0}</span>}
                </button>

                {colleges.map((c) => {
                    const active = college === c.id;

                    return (
                        <button
                            key={c.id}
                            type="button"
                            className={active ? "filter-chip college active" : "filter-chip college"}
                            aria-pressed={active}
                            onClick={() => onChange(active ? null : c.id)}
                        >
                            {c.name}
                            {counts && <span className="filter-count">{counts[c.id] ?? 0}</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// Filter buttons over the roster - same look and behaviour as the console's
// FilterButtons (All, ✕ on the pressed button, click again to clear).
const ROSTER_BUTTONS: { filter: RosterFilter; label: string; dot: string }[] = [
    { filter: "code_live", label: "Code received", dot: "live" },
    { filter: "code_expired", label: "Code expired", dot: "expired" },
    { filter: "registered", label: "Registered", dot: "registered" },
    { filter: "rejected", label: "Rejected", dot: "rejected" },
];

function RosterFilterButtons({
    filter,
    counts,
    onChange,
}: {
    filter: RosterFilter | null;
    counts: AdminStudentPage["counts"] | null;
    onChange: (filter: RosterFilter | null) => void;
}) {
    return (
        <div className="filter-row">
            <span className="filter-label" id="status-filter-label">Status</span>
            <div className="filter-buttons" role="group" aria-labelledby="status-filter-label">
                <button
                    type="button"
                    className={filter === null ? "filter-chip all active" : "filter-chip all"}
                    aria-pressed={filter === null}
                    onClick={() => onChange(null)}
                >
                    {filter === null ? "All" : "← All"}
                    {counts && <span className="filter-count">{counts.all}</span>}
                </button>

                {ROSTER_BUTTONS.map((b) => {
                    const active = filter === b.filter;

                    return (
                        <button
                            key={b.filter}
                            type="button"
                            className={["filter-chip", b.dot, active ? "active" : "", filter !== null && !active ? "dim" : ""]
                                .filter(Boolean)
                                .join(" ")}
                            aria-pressed={active}
                            onClick={() => onChange(active ? null : b.filter)}
                        >
                            <span className={`filter-dot ${b.dot}`} aria-hidden="true" />
                            {b.label}
                            {counts && <span className="filter-count">{counts[b.filter]}</span>}
                            {active && (
                                <span className="filter-x" aria-label="Clear filter">
                                    ✕
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function displayName(s: AdminStudentRow): string {
    const combined = [s.first_name, s.last_name].filter(Boolean).join(" ");
    return combined || s.name || "(no name)";
}

export default function ManageStudents({ collegeName, onClose, onImported }: Props) {
    // Import section - unrelated to the roster below, kept from the original
    // per-mailbox modal. It imports into the college picked at login.
    const [ownStudents, setOwnStudents] = useState<StudentRow[]>([]);
    const [csv, setCsv] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);
    const [result, setResult] = useState<AutoAddResult | null>(null);
    const [copied, setCopied] = useState(false);

    // Read-only roster of this operator's mailbox, every college (Step 30).
    const [rosterTab, setRosterTab] = useState<RosterTab>("students");
    const [search, setSearch] = useState("");
    // College button pressed (null = all colleges), and the colleges to show.
    const [colleges, setColleges] = useState<College[]>([]);
    const [collegeFilter, setCollegeFilter] = useState<string | null>(null);
    // Filter button pressed (null = All), and the per-button counts that
    // come with each first page for the current search and college.
    const [statusFilter, setStatusFilter] = useState<RosterFilter | null>(null);
    const [counts, setCounts] = useState<AdminStudentPage["counts"] | null>(null);
    const [collegeCounts, setCollegeCounts] = useState<AdminStudentPage["collegeCounts"] | null>(null);
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [rows, setRows] = useState<AdminStudentRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [rosterLoading, setRosterLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [rosterError, setRosterError] = useState<string | null>(null);

    const listRef = useRef<HTMLDivElement>(null);
    const dialogRef = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = dialogRef.current;
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog?.showModal();
        return () => {
            dialog?.close();
            opener?.focus();
        };
    }, []);


    useEffect(() => {
        fetchStudents()
            .then(setOwnStudents)
            .catch(() => {});
        fetchColleges()
            .then(setColleges)
            .catch(() => {});
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => clearTimeout(timer);
    }, [search]);

    const loadRoster = useCallback(
        (searchText: string, status: RosterFilter | null, college: string | null) => {
            setRosterLoading(true);
            setRosterError(null);

            fetchAdminStudents(searchText, null, status, college)
                .then((page) => {
                    setRows(page.students);
                    setCursor(page.nextCursor);
                    setCounts(page.counts ?? null);
                    setCollegeCounts(page.collegeCounts ?? null);
                })
                .catch((err) =>
                    setRosterError(
                        err instanceof Error ? err.message : "Failed to load students"
                    )
                )
                .finally(() => setRosterLoading(false));
        },
        []
    );

    useEffect(() => {
        if (rosterTab === "add") {
            return;
        }

        loadRoster(debouncedSearch, statusFilter, collegeFilter);
    }, [rosterTab, debouncedSearch, statusFilter, collegeFilter, loadRoster]);

    const loadMore = useCallback(() => {
        if (!cursor || loadingMore) {
            return;
        }

        setLoadingMore(true);

        fetchAdminStudents(debouncedSearch, cursor, statusFilter, collegeFilter)
            .then((page) => {
                setRows((prev) => [...prev, ...page.students]);
                setCursor(page.nextCursor);
            })
            .catch((err) =>
                setRosterError(err instanceof Error ? err.message : "Failed to load more")
            )
            .finally(() => setLoadingMore(false));
    }, [cursor, loadingMore, debouncedSearch, statusFilter, collegeFilter]);

    function handleScroll() {
        const el = listRef.current;

        if (!el || !cursor || loadingMore) {
            return;
        }

        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
            loadMore();
        }
    }

    async function handleImport() {
        setImportError(null);
        setResult(null);
        setSubmitting(true);

        try {
            const res = await autoAddStudents(csv);
            setResult(res);
            // Failed lines stay in the box so only those are retried; lines
            // that were added or skipped are done.
            setCsv(
                res.rows
                    .filter((r) => r.status === "failed")
                    .map((r) => `${r.name},${r.admissionId}`)
                    .join("\n")
            );
            fetchStudents().then(setOwnStudents).catch(() => {});
            loadRoster(debouncedSearch, statusFilter, collegeFilter);
            onImported();
        } catch (err) {
            setImportError(err instanceof Error ? err.message : "Adding students failed");
        } finally {
            setSubmitting(false);
        }
    }

    async function copyNewEmails() {
        const emails = (result?.rows ?? []).filter((r) => r.status === "added" && r.email).map((r) => r.email);

        try {
            await navigator.clipboard.writeText(emails.join("\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard blocked - the emails are still on screen.
        }
    }

    // Escape and a stray backdrop click are easy to hit by accident - ignore
    // them while an import is in flight, or its result panel (which rows
    // were rejected) is lost. The × button still closes deliberately.
    function closeUnlessBusy() {
        if (!submitting) {
            onClose();
        }
    }

    return (
        <dialog ref={dialogRef} className="student-dialog" onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter((element) => element.getClientRects().length > 0);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }} aria-labelledby="manage-students-title" onCancel={(event) => { event.preventDefault(); closeUnlessBusy(); }} onClick={(event) => { if (event.target === event.currentTarget) closeUnlessBusy(); }}>
            <div
                className="modal-card modal-card-wide"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h2 id="manage-students-title">Students</h2>
                    <button className="modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>

                {/* Same pill buttons as the console's filters. */}
                <div className="filter-buttons view-switch" role="group" aria-label="Student views">
                    {(
                        [
                            ["students", "Search students"],
                            ["add", "Add students"],
                        ] as const
                    ).map(([tab, label]) => (
                        <button
                            key={tab}
                            type="button"
                            aria-pressed={rosterTab === tab}
                            className={rosterTab === tab ? "filter-chip active" : "filter-chip"}
                            onClick={() => setRosterTab(tab)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {rosterTab === "add" && (
                    <div className="import-section">
                        <h3>Add to {collegeName} <span className="hint-text">(the college you selected at login)</span></h3>
                        <p className="hint-text" id="import-help">Paste one student per line: name, then Application No. You can include the header.</p>
                        <div className="import-example"><code>Student Name,Application No</code></div>
                        <p className="hint-text">
                            Set automatically: the email (first word.last word@myemailinfo.com, with a number added after the name if taken), the password <code>password</code> and the current year. Up to 10 students at a time.
                        </p>

                        <textarea
                            aria-label="Students to add"
                            aria-describedby="import-help"
                            rows={6}
                            placeholder={
                                "Student Name,Application No\n" +
                                "Jane Doe,10012345\n" +
                                "John Roe,10012346"
                            }
                            value={csv}
                            onChange={(e) => setCsv(e.target.value)}
                            disabled={submitting}
                        />

                        {importError && <p className="error" role="alert">{importError}</p>}

                        <button
                            className="send-button"
                            onClick={handleImport}
                            disabled={submitting || csv.trim().length === 0}
                        >
                            {submitting && <span className="spinner" />}
                            {submitting ? "Creating mailboxes..." : "Create mailboxes and add"}
                        </button>

                        {result && (
                            <div className="import-result" role="status">
                                <p className="autoadd-summary">
                                    <span className="autoadd-pill ok">{result.added} added</span>
                                    {result.skipped > 0 && <span className="autoadd-pill warn">{result.skipped} skipped</span>}
                                    {result.failed > 0 && <span className="autoadd-pill bad">{result.failed} failed</span>}
                                </p>
                                <div className="autoadd-table-wrap">
                                    <table className="autoadd-table">
                                        <thead>
                                            <tr>
                                                <th>Student</th>
                                                <th>App No</th>
                                                <th>Email created</th>
                                                <th>Result</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {result.rows.map((r) => (
                                                <tr key={r.line}>
                                                    <td className="autoadd-name">{r.name || "—"}</td>
                                                    <td>{r.admissionId || "—"}</td>
                                                    <td className="autoadd-email">{r.status === "added" ? r.email : "—"}</td>
                                                    <td>
                                                        <span className={`autoadd-tag ${r.status}`}>{r.status.toUpperCase()}</span>
                                                        {r.reason && <span className="autoadd-why">{r.reason}</span>}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                {result.added > 0 && (
                                    <p className="hint-text">
                                        <button type="button" className="autoadd-copy" onClick={copyNewEmails}>
                                            {copied ? "Copied" : "Copy new emails"}
                                        </button>{" "}
                                        All new mailboxes use the password <code>password</code>.
                                    </p>
                                )}
                                {result.failed > 0 && (
                                    <p className="hint-text">Failed lines are back in the box above so you can fix them and try again.</p>
                                )}
                            </div>
                        )}

                        {ownStudents.length === 0 && (
                            <p className="hint-text">
                                No students assigned to your mailbox yet.
                            </p>
                        )}
                    </div>
                )}

                {rosterTab === "students" && (
                <div className="roster-section">
                    <input
                        className="admin-search"
                        type="text"
                        aria-label="Search student roster"
                        placeholder="Search name, email, or Application No…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />

                    <CollegeButtons
                        colleges={colleges}
                        college={collegeFilter}
                        counts={collegeCounts}
                        onChange={setCollegeFilter}
                    />
                    <RosterFilterButtons filter={statusFilter} counts={counts} onChange={setStatusFilter} />

                    {rosterError && <p className="error" role="alert">{rosterError}</p>}

                    <div className="admin-list" ref={listRef} onScroll={handleScroll} tabIndex={0} role="region" aria-label="Student roster">
                    <div className="admin-list-header">
                        <span className="admin-cell admin-name">Name</span>
                        <span className="admin-cell admin-email">Email</span>
                        <span className="admin-cell admin-admission">Application No</span>
                        <span className="admin-cell admin-college">College</span>
                        <span className="admin-cell admin-year">Year enrolled</span>
                        <span className="admin-cell admin-status">Edugate status</span>
                    </div>

                        {rosterLoading ? (
                            <p className="empty-state">Loading...</p>
                        ) : rows.length === 0 ? (
                            <p className="empty-state">No students match.</p>
                        ) : (
                            <>
                                {rows.map((s) => (
                                    <div className="admin-row" key={s.id}>
                                        <span className="admin-cell admin-name" title={displayName(s)}>
                                            {displayName(s)}
                                        </span>
                                        <span className="admin-cell admin-email" title={s.email}>{s.email}</span>
                                        <span className="admin-cell admin-admission">
                                            {s.admission_id || "—"}
                                        </span>
                                        <span className="admin-cell admin-college" title={s.college_name ?? undefined}>
                                            {s.college_name ?? "—"}
                                        </span>
                                        <span className="admin-cell admin-year">
                                            {s.year_enrolled ?? "—"}
                                        </span>
                                        <RegistrationStatus s={s} />
                                    </div>
                                ))}
                                {loadingMore && (
                                    <p className="empty-state">Loading more...</p>
                                )}
                            </>
                        )}
                    </div>
                </div>
                )}
            </div>
        </dialog>
    );
}
