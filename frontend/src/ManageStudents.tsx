import { useCallback, useEffect, useRef, useState } from "react";
import {
    deleteStudents,
    fetchAdminStudents,
    fetchPendingCounts,
    fetchStudents,
    importStudents,
    restoreStudent,
} from "./api";
import type { AdminStudentRow, ImportResult, StudentRow } from "./types";

interface Props {
    collegeName: string;
    onClose: () => void;
    onImported: () => void;
}

type RosterTab = "students" | "deleted" | "add";

const MAX_DELETE_BATCH = 5;

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
        (tab: RosterTab, searchText: string) => {
            setRosterLoading(true);
            setRosterError(null);
            setSelected(new Set());
            setConfirming(false);

            fetchAdminStudents(searchText, null, tab === "deleted")
                .then((page) => {
                    setRows(page.students);
                    setCursor(page.nextCursor);
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

        loadRoster(rosterTab, debouncedSearch);
    }, [rosterTab, debouncedSearch, loadRoster]);

    const loadMore = useCallback(() => {
        if (!cursor || loadingMore) {
            return;
        }

        setLoadingMore(true);

        fetchAdminStudents(debouncedSearch, cursor, rosterTab === "deleted")
            .then((page) => {
                setRows((prev) => [...prev, ...page.students]);
                setCursor(page.nextCursor);
            })
            .catch((err) =>
                setRosterError(err instanceof Error ? err.message : "Failed to load more")
            )
            .finally(() => setLoadingMore(false));
    }, [cursor, loadingMore, debouncedSearch, rosterTab]);

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
            loadRoster(rosterTab, debouncedSearch);
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
            loadRoster(rosterTab, debouncedSearch);
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

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="modal-card modal-card-wide"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h2>Manage students</h2>
                    <button className="modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>

                <nav className="tabs">
                    <button
                        className={rosterTab === "students" ? "tab active" : "tab"}
                        onClick={() => setRosterTab("students")}
                    >
                        Students
                    </button>
                    <button
                        className={rosterTab === "deleted" ? "tab active" : "tab"}
                        onClick={() => setRosterTab("deleted")}
                    >
                        Deleted
                    </button>
                    <button
                        className={rosterTab === "add" ? "tab active" : "tab"}
                        onClick={() => setRosterTab("add")}
                    >
                        Add students
                    </button>
                </nav>

                {rosterTab === "add" && (
                    <div className="import-section">
                        <p className="hint-text">
                            One student per line, in the order{" "}
                            <code>Student Name,Application No,Email,Password</code>.
                            An optional header line in that exact form is
                            skipped if you include it. All rows import
                            into your currently selected college,{" "}
                            <strong>{collegeName}</strong>. Password is
                            optional - leave it blank to default to{" "}
                            <code>password</code>; otherwise it's that
                            student's mailbox password, used for sending
                            replies. Re-pasting an unchanged row for a student
                            that was previously deleted restores them;
                            re-pasting a row with different details for an
                            existing email is flagged for review, never
                            silently overwritten.
                        </p>

                        <textarea
                            rows={5}
                            placeholder={
                                "Student Name,Application No,Email,Password\n" +
                                "Jane Doe,10012345,jane.doe@myemailinfo.com,S3cret!\n" +
                                "John Roe,10012346,john.roe@myemailinfo.com,"
                            }
                            value={csv}
                            onChange={(e) => setCsv(e.target.value)}
                            disabled={submitting}
                        />

                        {importError && <p className="error">{importError}</p>}

                        <button
                            className="send-button"
                            onClick={handleImport}
                            disabled={submitting || csv.trim().length === 0}
                        >
                            {submitting && <span className="spinner" />}
                            {submitting ? "Importing..." : "Import"}
                        </button>

                        {result && (
                            <div className="import-result">
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
                        placeholder="Search name, email, or college..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />

                    {rosterError && <p className="error">{rosterError}</p>}

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

                    <div className="admin-list-header">
                        {rosterTab === "students" && <span className="admin-checkbox-spacer" />}
                        <span className="admin-cell admin-name">Name</span>
                        <span className="admin-cell admin-email">Email</span>
                        <span className="admin-cell admin-admission">Application No</span>
                        <span className="admin-cell admin-year">Year enrolled</span>
                        {rosterTab === "deleted" && <span className="admin-action-spacer" />}
                    </div>

                    <div className="admin-list" ref={listRef} onScroll={handleScroll}>
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
                                                checked={selected.has(s.id)}
                                                onChange={() => toggleSelected(s.id)}
                                                disabled={
                                                    !selected.has(s.id) &&
                                                    selected.size >= MAX_DELETE_BATCH
                                                }
                                            />
                                        )}
                                        <span className="admin-cell admin-name">
                                            {displayName(s)}
                                        </span>
                                        <span className="admin-cell admin-email">{s.email}</span>
                                        <span className="admin-cell admin-admission">
                                            {s.admission_id || "—"}
                                        </span>
                                        <span className="admin-cell admin-year">
                                            {s.year_enrolled ?? "—"}
                                        </span>
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
        </div>
    );
}
