import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shortDateTime } from "./format";
import { applicationNumbers, checkStudentLines, type TakenNumber } from "./studentLines";
import { autoAddStudents, checkApplicationNumbers, fetchAdminStudents, fetchStudents } from "./api";
import type {
    AdminStudentPage,
    AdminStudentRow,
    RosterFilter,
    StudentRow,
} from "./types";

export type StudentsMode = "search" | "add";

// One line of the Add students result. The email only exists once the student
// has really been added; until then the row shows just the name and Application No.
interface AddRow {
    text: string;
    name: string;
    admissionId: string;
    status: "waiting" | "trying" | "retrying" | "added" | "skipped" | "failed";
    email: string | null;
    reason: string | null;
}

interface Props {
    mode: StudentsMode;
    // The college chosen at login: its id starts as the College filter of Search students.
    collegeId: string;
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
            <div className="filter-buttons" role="group" aria-label="Status">
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

export default function ManageStudents({ mode, collegeId, collegeName, onClose, onImported }: Props) {
    // Import section - unrelated to the roster below, kept from the original
    // per-mailbox modal. It imports into the college picked at login.
    const [ownStudents, setOwnStudents] = useState<StudentRow[]>([]);
    const [csv, setCsv] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);
    const [addRows, setAddRows] = useState<AddRow[] | null>(null);
    const mounted = useRef(true);
    const [copied, setCopied] = useState(false);
    // Mistakes in the box are shown as the clerk types; Add stays off until none are left.
    // Application Nos the server said are already used in this college (asked when the
    // clerk leaves the box and when Add is pressed). Keyed by number, so changing a number
    // clears its flag, and a number never asked about is simply not flagged.
    const [taken, setTaken] = useState<Record<string, TakenNumber>>({});
    const [checking, setChecking] = useState(false);
    const lineCheck = useMemo(() => checkStudentLines(csv, taken), [csv, taken]);

    // Read-only roster of this operator's mailbox, every college (Step 30).
    // Search and Add are two separate dialogs (two buttons in the console header).
    const rosterTab: RosterTab = mode === "add" ? "add" : "students";
    const [search, setSearch] = useState("");
    // College button pressed (null = all colleges), and the colleges to show.
    // Starts on the college chosen at login (the All button still shows every college).
    const [collegeFilter, setCollegeFilter] = useState<string | null>(collegeId);
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

    // Stops an add in progress from carrying on after the dialog is closed.
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

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

    // One pass over the given lines, one at a time in order (one request per
    // line). Each row shows `busy` while its request runs, then Added with the
    // email, Skipped, or Failed with the reason, as soon as the answer arrives.
    // Returns the lines that failed.
    async function runPass(items: { index: number; text: string }[], busy: "trying" | "retrying") {
        const failed: { index: number; text: string }[] = [];

        for (const item of items) {
            if (!mounted.current) {
                return failed;
            }

            setAddRows((prev) =>
                prev && prev.map((r, i) => (i === item.index ? { ...r, status: busy, reason: busy === "trying" ? null : r.reason } : r))
            );

            let outcome: Pick<AddRow, "status" | "email" | "reason">;

            try {
                const res = await autoAddStudents(item.text);
                const row = res.rows[0];
                outcome = row
                    ? { status: row.status, email: row.status === "added" ? row.email : null, reason: row.reason }
                    : { status: "failed", email: null, reason: "The server sent no answer for this line" };
            } catch (err) {
                outcome = {
                    status: "failed",
                    email: null,
                    reason: err instanceof Error ? err.message : "Could not reach the server",
                };
            }

            if (!mounted.current) {
                return failed;
            }

            if (outcome.status === "failed") {
                failed.push(item);
            }

            setAddRows((prev) => prev && prev.map((r, i) => (i === item.index ? { ...r, ...outcome } : r)));
        }

        return failed;
    }

    // Every line once; then the lines that failed get ONE retry, at the end,
    // shown as "Retrying"; a retry is a new request, so an address taken in the
    // meantime gets the next number. Lines still failing go back into the box.
    async function addLines(rows: AddRow[]) {
        setSubmitting(true);

        let failed = await runPass(rows.map((r, index) => ({ index, text: r.text })), "trying");

        if (failed.length > 0 && mounted.current) {
            failed = await runPass(failed, "retrying");
        }

        if (!mounted.current) {
            return;
        }

        setCsv(failed.map((f) => f.text).join("\n"));
        setSubmitting(false);
        fetchStudents().then(setOwnStudents).catch(() => {});
        loadRoster(debouncedSearch, statusFilter, collegeFilter);
        onImported();
    }

    // Asks the server which of the box's Application Nos are already used. Fails quietly
    // (nothing known) - adding checks again anyway. Returns what is now known.
    async function lookUpNumbers(text: string): Promise<Record<string, TakenNumber>> {
        const numbers = applicationNumbers(text);
        const found = await checkApplicationNumbers(numbers);
        const merged = { ...taken, ...found };

        if (mounted.current) {
            setTaken(merged);
        }

        return merged;
    }

    async function handleImport() {
        if (lineCheck.errors.length > 0 || lineCheck.lines.length === 0 || checking) {
            return;
        }

        // One look-up for the whole box before anything is created: a number that is
        // already used is flagged in red and nothing is added until it is fixed.
        setChecking(true);
        const known = await lookUpNumbers(csv);

        if (!mounted.current) {
            return;
        }

        setChecking(false);

        if (checkStudentLines(csv, known).errors.length > 0) {
            return;
        }

        setImportError(null);
        setCopied(false);
        const rows: AddRow[] = lineCheck.lines.map((l) => ({
            text: l.text,
            name: l.name,
            admissionId: l.admissionId,
            status: "waiting",
            email: null,
            reason: null,
        }));
        setAddRows(rows);
        setCsv("");
        void addLines(rows);
    }

    // The added students as a CSV (header, then one line per student, comma
    // separated): Student Name,College,Application No,Email. Names are letters
    // and spaces only (and college names have no commas), so no value ever needs
    // quoting. The mailbox password is deliberately not included.
    async function copyData() {
        const lines = (addRows ?? [])
            .filter((r) => r.status === "added" && r.email)
            .map((r) => `${r.name},${collegeName},${r.admissionId},${r.email}`);

        try {
            await navigator.clipboard.writeText(["Student Name,College,Application No,Email", ...lines].join("\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard blocked - the data is still on screen.
        }
    }

    // Escape is easy to hit by accident - ignore it while an import is in
    // flight, or its result panel (which rows were rejected) is lost. A click
    // outside the dialog no longer closes it at all (dragging the mouse out of
    // the card while selecting text closed it and lost the results); only the ×
    // button and Escape close it.
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
        }} aria-labelledby="manage-students-title" onCancel={(event) => { event.preventDefault(); closeUnlessBusy(); }}>
            <div
                className="modal-card modal-card-wide"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header">
                    <h2 id="manage-students-title">
                        {mode === "add" ? "Add students" : `Search students · ${collegeFilter === null ? "all colleges" : collegeName}`}
                    </h2>
                    <button className="modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>

                {rosterTab === "add" && (
                    <div className="import-section">
                        <h3>Add to {collegeName} <span className="hint-text">(the college you selected at login)</span></h3>
                        <div className="import-help" id="import-help">
                            <p className="hint-text">Type one student per line:</p>
                            <div className="import-example"><code>&lt;student name&gt;,&lt;application number&gt;</code></div>
                            <ul className="import-rules">
                                <li><strong>Name</strong> - full name with only uppercase and lowercase letters. Eg <code>Rohit Kumar Khanna</code></li>
                                <li>The <strong>comma ( , )</strong> is required after that</li>
                                <li><strong>Application number</strong> - only numbers, no letters. Eg <code>1423423</code></li>
                            </ul>
                        </div>
                        <p className="hint-text">
                            Set automatically: the email (first word.last word@myemailinfo.com, with a number added after the name if taken) and the current year. Up to <strong>10 students at a time</strong>.
                        </p>

                        <textarea
                            aria-label="Students to add"
                            aria-describedby="import-help"
                            rows={6}
                            placeholder={
                                "Rohit Kumar Khanna,1423423\n" +
                                "Jane Doe,1423424"
                            }
                            value={csv}
                            onChange={(e) => setCsv(e.target.value)}
                            onBlur={() => void lookUpNumbers(csv)}
                            disabled={submitting}
                            aria-invalid={lineCheck.errors.length > 0}
                        />

                        {lineCheck.errors.length > 0 && (
                            <div className="line-errors" role="alert">
                                <p>Fix these before adding. The Add button stays off until every line is right.</p>
                                <ul>
                                    {lineCheck.errors.map((e, index) => (
                                        <li key={index}>
                                            {e.line > 0 && <span className="line-errors-text">Line {e.line}: {e.text}</span>}
                                            <span className="line-errors-why">{e.message}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {importError && <p className="error" role="alert">{importError}</p>}

                        <button
                            className="send-button"
                            onClick={handleImport}
                            disabled={submitting || checking || csv.trim().length === 0 || lineCheck.count === 0 || lineCheck.errors.length > 0}
                        >
                            {(submitting || checking) && <span className="spinner" />}
                            {checking ? "Checking numbers..." : submitting ? "Creating mailboxes..." : "Create mailboxes and add"}
                        </button>

                        {addRows && (
                            <div className="import-result" role="status">
                                <p className="autoadd-summary">
                                    <span className="autoadd-pill ok">{addRows.filter((r) => r.status === "added").length} added</span>
                                    {addRows.some((r) => ["waiting", "trying", "retrying"].includes(r.status)) && (
                                        <span className="autoadd-pill busy">{addRows.filter((r) => ["waiting", "trying", "retrying"].includes(r.status)).length} in progress</span>
                                    )}
                                    {addRows.some((r) => r.status === "skipped") && (
                                        <span className="autoadd-pill warn">{addRows.filter((r) => r.status === "skipped").length} skipped</span>
                                    )}
                                    {addRows.some((r) => r.status === "failed") && (
                                        <span className="autoadd-pill bad">{addRows.filter((r) => r.status === "failed").length} failed</span>
                                    )}
                                </p>
                                <div className="autoadd-table-wrap">
                                    <table className="autoadd-table">
                                        <thead>
                                            <tr>
                                                <th>Student</th>
                                                <th>App No</th>
                                                <th>Email</th>
                                                <th>Result</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {addRows.map((r, index) => (
                                                <tr key={index}>
                                                    <td className="autoadd-name">{r.name}</td>
                                                    <td>{r.admissionId}</td>
                                                    <td className="autoadd-email">{r.status === "added" ? r.email : "—"}</td>
                                                    <td>
                                                        <span className={`autoadd-tag ${r.status}`}>
                                                            {(r.status === "trying" || r.status === "retrying") && <span className="spinner" />}
                                                            {r.status === "waiting"
                                                                ? "WAITING"
                                                                : r.status === "trying"
                                                                  ? "TRYING TO ADD…"
                                                                  : r.status === "retrying"
                                                                    ? "RETRYING…"
                                                                    : r.status.toUpperCase()}
                                                        </span>
                                                        {r.reason && <span className="autoadd-why">{r.reason}</span>}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                <p className="hint-text">
                                    {addRows.some((r) => r.status === "added") && (
                                        <button type="button" className="autoadd-copy" onClick={copyData}>
                                            {copied ? "Copied" : "Copy data"}
                                        </button>
                                    )}{" "}
                                    {!submitting && addRows.some((r) => r.status === "failed") && (
                                        <>Failed lines were tried twice and are back in the box above. Fix them and add again.</>
                                    )}
                                </p>
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
                    <div className="roster-searchbar">
                        <input
                            className="admin-search"
                            type="text"
                            aria-label="Search student roster"
                            placeholder="Search name, email, or Application No…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                        {/* The list opens on the college chosen at login; this small button
                            switches to every college and back. */}
                        <button
                            type="button"
                            className="all-colleges-button"
                            aria-pressed={collegeFilter === null}
                            onClick={() => setCollegeFilter(collegeFilter === null ? collegeId : null)}
                        >
                            {collegeFilter === null
                                ? `Only ${collegeName}${collegeCounts ? ` ${collegeCounts[collegeId] ?? 0}` : ""}`
                                : `All colleges${collegeCounts ? ` ${collegeCounts.all ?? 0}` : ""}`}
                        </button>
                    </div>

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
