import { useCallback, useEffect, useRef, useState } from "react";
import { shortDateTime } from "./format";
import {
    deleteStudents,
    fetchAdminStudents,
    fetchPendingCounts,
    fetchStudents,
    importStudents,
    restoreStudent,
} from "./api";
import type { AdminStudentPage, AdminStudentRow, ImportResult, RosterFilter, StudentRow } from "./types";

interface Props {
    collegeName: string;
    onClose: () => void;
    onImported: () => void;
}

type RosterTab = "students" | "deleted" | "add";

const MAX_DELETE_BATCH = 5;


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
        <div className="filter-buttons" role="group" aria-label="Filter students">
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
    );
}

function displayName(s: AdminStudentRow): string {
    const combined = [s.first_name, s.last_name].filter(Boolean).join(" ");
    return combined || s.name || "(no name)";
}

export default function ManageStudents({ collegeName, onClose, onImported }: Props) {
    // Import section - unrelated to the roster below, kept from the original
    // per-mailbox modal.
    const [ownStudents, setOwnStudents] = useState<StudentRow[]>([]);
    const [csv, setCsv] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);
    const [result, setResult] = useState<ImportResult | null>(null);

    // Admin roster, scoped to this operator's mailbox and selected college.
    const [rosterTab, setRosterTab] = useState<RosterTab>("students");
    const [search, setSearch] = useState("");
    // Filter button pressed (null = All), and the per-button counts that
    // come with each first page for the current search.
    const [statusFilter, setStatusFilter] = useState<RosterFilter | null>(null);
    const [counts, setCounts] = useState<AdminStudentPage["counts"] | null>(null);
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [rows, setRows] = useState<AdminStudentRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [rosterLoading, setRosterLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [rosterError, setRosterError] = useState<string | null>(null);

    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [confirming, setConfirming] = useState(false);
    const [pendingCounts, setPendingCounts] = useState<Record<number, number>>({});
    const [deleting, setDeleting] = useState(false);
    const [restoringId, setRestoringId] = useState<number | null>(null);

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
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => clearTimeout(timer);
    }, [search]);

    const loadRoster = useCallback(
        (tab: RosterTab, searchText: string, status: RosterFilter | null) => {
            setRosterLoading(true);
            setRosterError(null);
            setSelected(new Set());
            setConfirming(false);

            fetchAdminStudents(searchText, null, tab === "deleted", tab === "students" ? status : null)
                .then((page) => {
                    setRows(page.students);
                    setCursor(page.nextCursor);
                    setCounts(page.counts ?? null);
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

        loadRoster(rosterTab, debouncedSearch, statusFilter);
    }, [rosterTab, debouncedSearch, statusFilter, loadRoster]);

    const loadMore = useCallback(() => {
        if (!cursor || loadingMore) {
            return;
        }

        setLoadingMore(true);

        fetchAdminStudents(debouncedSearch, cursor, rosterTab === "deleted", rosterTab === "students" ? statusFilter : null)
            .then((page) => {
                setRows((prev) => [...prev, ...page.students]);
                setCursor(page.nextCursor);
            })
            .catch((err) =>
                setRosterError(err instanceof Error ? err.message : "Failed to load more")
            )
            .finally(() => setLoadingMore(false));
    }, [cursor, loadingMore, debouncedSearch, rosterTab, statusFilter]);

    function handleScroll() {
        const el = listRef.current;

        if (!el || !cursor || loadingMore) {
            return;
        }

        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
            loadMore();
        }
    }

    function toggleSelected(id: number) {
        setSelected((prev) => {
            const next = new Set(prev);

            if (next.has(id)) {
                next.delete(id);
            } else if (next.size < MAX_DELETE_BATCH) {
                next.add(id);
            }

            return next;
        });
        setConfirming(false);
    }

    async function handleDeleteClick() {
        const ids = [...selected];

        if (ids.length === 0) {
            return;
        }

        try {
            const counts = await fetchPendingCounts(ids);
            setPendingCounts(counts);
            setConfirming(true);
        } catch (err) {
            setRosterError(
                err instanceof Error ? err.message : "Failed to check pending messages"
            );
        }
    }

    async function handleConfirmDelete() {
        const ids = [...selected];
        setDeleting(true);
        setRosterError(null);

        try {
            await deleteStudents(ids);
            setConfirming(false);
            loadRoster(rosterTab, debouncedSearch, statusFilter);
            onImported();
        } catch (err) {
            setRosterError(err instanceof Error ? err.message : "Delete failed");
        } finally {
            setDeleting(false);
        }
    }

    async function handleRestore(id: number) {
        setRestoringId(id);
        setRosterError(null);

        try {
            await restoreStudent(id);
            setRows((prev) => prev.filter((r) => r.id !== id));
            onImported();
        } catch (err) {
            setRosterError(err instanceof Error ? err.message : "Restore failed");
        } finally {
            setRestoringId(null);
        }
    }

    async function handleImport() {
        setImportError(null);
        setResult(null);
        setSubmitting(true);

        try {
            const res = await importStudents(csv);
            setResult(res);
            setCsv("");
            fetchStudents().then(setOwnStudents).catch(() => {});
            loadRoster(rosterTab, debouncedSearch, statusFilter);
            onImported();
        } catch (err) {
            setImportError(err instanceof Error ? err.message : "Import failed");
        } finally {
            setSubmitting(false);
        }
    }

    const totalPending = [...selected].reduce(
        (sum, id) => sum + (pendingCounts[id] || 0),
        0
    );

    // Escape and a stray backdrop click are easy to hit by accident - ignore
    // them while an import/delete is in flight, or its result panel (which
    // rows were rejected) is lost. The × button still closes deliberately.
    function closeUnlessBusy() {
        if (!submitting && !deleting) {
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
                    <h2 id="manage-students-title">Manage students</h2>
                    <button className="modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>

                {/* Same pill buttons as the console's filters. */}
                <div className="filter-buttons view-switch" role="group" aria-label="Student views">
                    {(
                        [
                            ["students", "Students"],
                            ["deleted", "Deleted"],
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
                        <h3>Import into {collegeName}</h3>
                        <p className="hint-text" id="import-help">Paste one student per line using the column order below. You can include the header.</p>
                        <div className="import-example"><code>Student Name,Application No,Email,Password</code></div>
                        <details className="import-details">
                            <summary>Password and duplicate row details</summary>
                            <p>Leave Password blank to use <code>password</code>, or supply the student's mailbox password for sending replies.</p>
                            <p>An unchanged row restores a previously deleted student. Different details for an existing email are flagged for review, never silently overwritten.</p>
                        </details>

                        <textarea
                            aria-label="Student import rows"
                            aria-describedby="import-help"
                            rows={6}
                            placeholder={
                                "Student Name,Application No,Email,Password\n" +
                                "Jane Doe,10012345,jane.doe@myemailinfo.com,S3cret!\n" +
                                "John Roe,10012346,john.roe@myemailinfo.com,"
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
                            {submitting ? "Importing..." : "Import"}
                        </button>

                        {result && (
                            <div className="import-result" role="status">
                                <p>
                                    {result.imported} added, {result.skipped} already
                                    imported, {result.rejected.length} rejected.
                                </p>
                                {result.rejected.length > 0 && (
                                    <ul className="rejected-list">
                                        {result.rejected.map((r) => (
                                            <li key={r.line}>
                                                Line {r.line} ({r.email}): {r.reason}
                                            </li>
                                        ))}
                                    </ul>
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

                {rosterTab !== "add" && (
                <div className="roster-section">
                    <input
                        className="admin-search"
                        type="text"
                        aria-label="Search student roster"
                        placeholder="Search name, email, or Application No…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />

                    {rosterTab === "students" && (
                        <RosterFilterButtons filter={statusFilter} counts={counts} onChange={setStatusFilter} />
                    )}

                    {rosterError && <p className="error" role="alert">{rosterError}</p>}

                    {rosterTab === "students" && selected.size > 0 && !confirming && (
                        <div className="selection-bar">
                            <span>{selected.size} selected</span>
                            <button className="secondary-button" onClick={handleDeleteClick}>
                                Delete selected
                            </button>
                        </div>
                    )}

                    {confirming && (
                        <div className="confirm-banner">
                            <p>
                                Delete {selected.size} student
                                {selected.size === 1 ? "" : "s"}?
                                {totalPending > 0 && (
                                    <strong>
                                        {" "}
                                        {totalPending} pending message
                                        {totalPending === 1 ? "" : "s"} among them
                                        will no longer be visible until restored.
                                    </strong>
                                )}
                            </p>
                            <div className="reply-actions">
                                <button
                                    className="send-button"
                                    onClick={handleConfirmDelete}
                                    disabled={deleting}
                                >
                                    {deleting && <span className="spinner" />}
                                    {deleting ? "Deleting..." : "Confirm delete"}
                                </button>
                                <button
                                    className="secondary-button"
                                    onClick={() => setConfirming(false)}
                                    disabled={deleting}
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}

                    <div className={`admin-list ${rosterTab}`} ref={listRef} onScroll={handleScroll} tabIndex={0} role="region" aria-label="Student roster">
                    <div className="admin-list-header">
                        {rosterTab === "students" && <span className="admin-checkbox-spacer" />}
                        <span className="admin-cell admin-name">Name</span>
                        <span className="admin-cell admin-email">Email</span>
                        <span className="admin-cell admin-admission">Application No</span>
                        <span className="admin-cell admin-year">Year enrolled</span>
                        <span className="admin-cell admin-status">Edugate status</span>
                        {rosterTab === "deleted" && <span className="admin-action-spacer" />}
                    </div>

                        {rosterLoading ? (
                            <p className="empty-state">Loading...</p>
                        ) : rows.length === 0 ? (
                            <p className="empty-state">
                                {rosterTab === "deleted"
                                    ? "No deleted students."
                                    : "No students match."}
                            </p>
                        ) : (
                            <>
                                {rows.map((s) => (
                                    <div className="admin-row" key={s.id}>
                                        {rosterTab === "students" && (
                                            <input
                                                type="checkbox"
                                                aria-label={`Select ${displayName(s)}`}
                                                checked={selected.has(s.id)}
                                                onChange={() => toggleSelected(s.id)}
                                                disabled={
                                                    !selected.has(s.id) &&
                                                    selected.size >= MAX_DELETE_BATCH
                                                }
                                            />
                                        )}
                                        <span className="admin-cell admin-name" title={displayName(s)}>
                                            {displayName(s)}
                                        </span>
                                        <span className="admin-cell admin-email" title={s.email}>{s.email}</span>
                                        <span className="admin-cell admin-admission">
                                            {s.admission_id || "—"}
                                        </span>
                                        <span className="admin-cell admin-year">
                                            {s.year_enrolled ?? "—"}
                                        </span>
                                        <RegistrationStatus s={s} />
                                        {rosterTab === "deleted" && (
                                            <button
                                                className="secondary-button"
                                                onClick={() => handleRestore(s.id)}
                                                disabled={restoringId === s.id}
                                            >
                                                {restoringId === s.id ? "Restoring..." : "Restore"}
                                            </button>
                                        )}
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
