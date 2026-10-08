import { useCallback, useEffect, useRef, useState } from "react";
import {
    checkStudentMail,
    fetchMailCheckMatches,
    fetchStudents,
    fetchThread,
    fetchThreadSummaries,
    logout,
    subscribeToUpdates,
    type MailCheckStudent,
    type ThreadFilter,
    type ThreadSummaryPage,
} from "./api";
import MessageList from "./MessageList";
import { playChime } from "./chime";
import FilterButtons from "./FilterButtons";
import { saveSearchForReload, takeSearchSavedForReload, useNewVersionAvailable } from "./versionCheck";
import ThreadView from "./ThreadView";
import ManageStudents, { type StudentsMode } from "./ManageStudents";
import CodeAlerts from "./CodeAlerts";
import { collegeLogo, ISM_EDUTECH_LOGO } from "./branding";
import type { College, StatusFilter, ThreadItem, ThreadSummary } from "./types";

// Step 18 phase 2: no Pending/Closed tabs any more - 88% of the mail is
// automated Edugate email nobody replies to, and staff don't use Close. One
// list, newest first, each thread with one badge (MessageList.tsx);
// superseded codes are hidden unless searching (backend threadBadge).
const STATUS: StatusFilter = "all";

// Friendly empty-list messages per filter button (Step 18 refresh).
const EMPTY_TEXT: Record<ThreadFilter | "all", string> = {
    all: "No emails match.",
    code_live: "No fresh codes right now.",
    code_expired: "No expired codes. Nobody is waiting on a new one.",
    registered: "No registrations match.",
    rejected: "No rejected documents. Nothing to re-upload.",
    other: "No other emails.",
};

type MailCheckState =
    | { phase: "checking"; students: MailCheckStudent[] }
    | { phase: "done"; students: MailCheckStudent[]; added: number; checkedAt: number }
    | { phase: "tooMany" };

function checkedAgo(checkedAt: number): string {
    const minutes = Math.floor((Date.now() - checkedAt) / 60000);
    return minutes < 1 ? "just now" : `${minutes} min ago`;
}

// Read once at load (module scope, so React's dev double-render can't
// consume it twice) - restores the search after an automatic reload to a
// newer build (see versionCheck.ts).
const searchAfterReload = takeSearchSavedForReload();

interface Props {
    college: College;
    onLoggedOut: () => void;
}

function Console({ college, onLoggedOut }: Props) {
    const status = STATUS;
    // Filter buttons (Step 18): null = "All".
    const [filter, setFilter] = useState<ThreadFilter | null>(null);
    const [counts, setCounts] = useState<ThreadSummaryPage["counts"] | null>(null);
    const [threads, setThreads] = useState<ThreadSummary[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [threadItems, setThreadItems] = useState<ThreadItem[] | null>(null);
    const [loading, setLoading] = useState(true);
    const listRequest = useRef(0);
    const threadRequest = useRef(0);
    const [loadedThreadId, setLoadedThreadId] = useState<number | null>(null);
    const [threadError, setThreadError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Which students dialog is open: Search students and Add students are two buttons, two dialogs.
    const [studentsDialog, setStudentsDialog] = useState<StudentsMode | null>(null);
    // Bumped on every live update so the code alert rows refresh at once.
    const [alertsRefreshKey, setAlertsRefreshKey] = useState(0);

    // Single search box shared across both tabs - the same term stays
    // applied when switching Pending/Closed, so a user unsure which tab a
    // thread landed in doesn't have to retype anything (per the customer's
    // own framing of that workflow).
    const [search, setSearch] = useState(searchAfterReload);
    const [debouncedSearch, setDebouncedSearch] = useState(searchAfterReload.trim());

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => clearTimeout(timer);
    }, [search]);

    // Step 16: when the search narrows to exactly one student, their own
    // mailbox is checked directly and anything missing from the console is
    // added. Failures deliberately show nothing (the status line just goes
    // away) - operators can't act on them; the reason is in the server log.
    const [mailCheck, setMailCheck] = useState<MailCheckState | null>(null);
    // Bumped on every search change so a slow check for an earlier search
    // can never overwrite the status line of the current one.
    const mailCheckSeq = useRef(0);

    const loadMessages = useCallback(async (statusFilter: StatusFilter, searchText: string, filterValue: ThreadFilter | null) => {
        const request = ++listRequest.current;
        setLoading(true);
        setError(null);

        try {
            const page = await fetchThreadSummaries(statusFilter, 0, undefined, searchText, filterValue);
            if (request !== listRequest.current) return;
            setCounts(page.counts ?? null);
            setThreads(page.threads);
            setHasMore(page.hasMore);
        } catch (err) {
            if (request === listRequest.current) {
                setError(err instanceof Error ? err.message : "Failed to load messages");
            }
        } finally {
            if (request === listRequest.current) setLoading(false);
        }
    }, []);

    const loadMore = useCallback(async () => {
        const request = listRequest.current;
        setLoadingMore(true);
        setError(null);

        try {
            const page = await fetchThreadSummaries(status, threads.length, undefined, debouncedSearch, filter);
            if (request !== listRequest.current) return;
            setThreads((prev) => [...prev, ...page.threads]);
            setHasMore(page.hasMore);
        } catch (err) {
            if (request === listRequest.current) setError(err instanceof Error ? err.message : "Failed to load more");
        } finally {
            setLoadingMore(false);
        }
    }, [status, threads.length, debouncedSearch, filter]);

    const loadThread = useCallback((id: number) => {
        const request = ++threadRequest.current;
        setThreadError(null);
        fetchThread(id)
            .then((items) => {
                if (request !== threadRequest.current) return;
                setThreadItems(items);
                setLoadedThreadId(id);
            })
            .catch((err) => {
                if (request !== threadRequest.current) return;
                setThreadError(err instanceof Error ? err.message : "Failed to load thread");
            });
    }, []);

    useEffect(() => {
        loadMessages(status, debouncedSearch, filter);
        setThreads([]);
        setSelectedId(null);
        setThreadItems(null);
        setLoadedThreadId(null);
        setThreadError(null);
        threadRequest.current++;
    }, [status, debouncedSearch, filter, loadMessages]);

    // Checks every matched student's mailbox in parallel and reports the
    // total. A student whose check fails is just left out of the total -
    // failures are only logged server-side; if all fail the line disappears.
    const runMailCheck = useCallback(
        async (students: MailCheckStudent[], force: boolean) => {
            const seq = mailCheckSeq.current;
            setMailCheck({ phase: "checking", students });

            const outcomes = await Promise.all(
                students.map((student) => checkStudentMail(student.id, force))
            );

            if (seq !== mailCheckSeq.current) {
                return;
            }

            const ok = outcomes.filter((o) => o.status === "ok");

            if (ok.length === 0) {
                setMailCheck(null);
                return;
            }

            const added = ok.reduce((sum, o) => sum + o.added, 0);
            const checkedAt = Math.min(...ok.map((o) => o.checkedAt));
            setMailCheck({ phase: "done", students, added, checkedAt });

            if (added > 0) {
                // The server also broadcasts an update, but refresh directly
                // so this operator sees the added emails even if their live
                // connection has dropped.
                loadMessages(statusRef.current, searchRef.current, filterRef.current);
            }
        },
        [loadMessages]
    );

    // Waits a little longer than the search debounce (~1.5s after typing
    // stops in total) so a check doesn't fire while someone is mid-word.
    // Up to 3 matching students are checked; more than that only shows a
    // hint to type the email (the one search that always matches exactly
    // one student - even full names repeat in the roster).
    useEffect(() => {
        mailCheckSeq.current++;
        setMailCheck(null);

        if (!debouncedSearch) {
            return;
        }

        const seq = mailCheckSeq.current;
        const timer = setTimeout(async () => {
            const { students, tooMany } = await fetchMailCheckMatches(debouncedSearch);

            if (seq !== mailCheckSeq.current) {
                return;
            }

            if (tooMany) {
                setMailCheck({ phase: "tooMany" });
            } else if (students.length > 0) {
                runMailCheck(students, false);
            }
        }, 1200);

        return () => clearTimeout(timer);
    }, [debouncedSearch, runMailCheck]);

    useEffect(() => {
        fetchStudents()
            .then((students) => {
                if (students.length === 0) {
                    setStudentsDialog("add");
                }
            })
            .catch(() => {});
        // Only check once on mount - the user can always reopen manually.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (selectedId === null) {
            return;
        }

        loadThread(selectedId);
    }, [selectedId, loadThread]);

    const statusRef = useRef(status);
    const selectedIdRef = useRef(selectedId);
    const searchRef = useRef(debouncedSearch);
    const filterRef = useRef(filter);
    // Stable for the live-update subscription (App passes a new arrow each render).
    const onLoggedOutRef = useRef(onLoggedOut);

    useEffect(() => {
        onLoggedOutRef.current = onLoggedOut;
    }, [onLoggedOut]);

    useEffect(() => {
        filterRef.current = filter;
    }, [filter]);

    useEffect(() => {
        statusRef.current = status;
    }, [status]);

    useEffect(() => {
        selectedIdRef.current = selectedId;
    }, [selectedId]);

    useEffect(() => {
        searchRef.current = debouncedSearch;
    }, [debouncedSearch]);

    useEffect(() => {
        return subscribeToUpdates((event) => {
            // New incoming mail for this console's college → chime. Staff
            // actions (replies, closes) and mailbox-check recoveries stay
            // silent.
            if (event.reason === "new-mail" && event.collegeIds?.includes(String(college.id))) {
                playChime();
            }

            // A new-mail sync or any operator's reply/close action changes
            // the pending set - reload from the top so everyone's view
            // (list + open thread + pending count) stays consistent with
            // the server.
            loadMessages(statusRef.current, searchRef.current, filterRef.current);
            setAlertsRefreshKey((k) => k + 1);

            if (selectedIdRef.current !== null) {
                loadThread(selectedIdRef.current);
            }
        }, () => onLoggedOutRef.current());
    }, [loadMessages, loadThread, college.id]);

    function handleReplySent() {
        loadMessages(status, debouncedSearch, filter);

        if (selectedId !== null) {
            loadThread(selectedId);
        }
    }

    // A newer build was deployed: reload onto it, but never while an email
    // is open - the operator may be typing a reply - or a students dialog is
    // open - an add may be running and its result table would be lost. Waits
    // until they leave it. The search box is carried across the reload.
    const newVersionAvailable = useNewVersionAvailable();

    useEffect(() => {
        if (newVersionAvailable && selectedId === null && studentsDialog === null) {
            saveSearchForReload(search);
            window.location.reload();
        }
    }, [newVersionAvailable, selectedId, studentsDialog, search]);

    async function handleLogout() {
        await logout();
        onLoggedOut();
    }

    return (
        <div className="app">
            {/* Header, search and filters stay put; only the list and the
                email scroll (Step 18 refresh). */}
            <div className="console-top">
            <header className="app-header">
                <div className="header-brand">
                    <img className="header-logo" src={ISM_EDUTECH_LOGO} alt="ISM Edutech" />
                    {collegeLogo(college.name) && (
                        <img className="header-logo header-college-logo" src={collegeLogo(college.name)} alt="" />
                    )}
                </div>
                {/* Centred across the whole window, whatever the logo widths. */}
                <div className="header-title">
                    <h1>Student Mail Console</h1>
                    <p className="console-college">{college.name}</p>
                </div>
                <div className="session-bar">
                    <button
                        className="logout-button"
                        onClick={() => setStudentsDialog("search")}
                    >
                        Search students
                    </button>
                    <button
                        className="logout-button"
                        onClick={() => setStudentsDialog("add")}
                    >
                        Add students
                    </button>
                    <a
                        className="logout-button"
                        href="/status"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        System status
                    </a>
                    <button className="logout-button quiet" onClick={handleLogout}>
                        Log out
                    </button>
                </div>
            </header>

            {studentsDialog && (
                <ManageStudents
                    mode={studentsDialog}
                    collegeName={college.name}
                    onClose={() => setStudentsDialog(null)}
                    onImported={() => {
                        loadMessages(status, debouncedSearch, filter);
                    }}
                />
            )}

            {/* Search + filters on the left; code expiry alerts on the right,
                above the email pane (Step 27). */}
            <div className="console-controls">
            <div className="console-controls-main">
            <div className="console-search">
                <input
                    className="admin-search"
                    type="text"
                    aria-label="Search students by name or email"
                    placeholder="Search students by name or email…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                    <button
                        className="console-search-clear"
                        onClick={() => setSearch("")}
                        aria-label="Clear search"
                    >
                        &times;
                    </button>
                )}
            </div>

            {mailCheck?.phase === "tooMany" && (
                <div className="mail-check hint">
                    <span>To check a student's mailbox, type their email.</span>
                </div>
            )}

            {mailCheck?.phase === "checking" && (
                <div className="mail-check checking">
                    <span className="mail-check-spinner" aria-hidden="true" />
                    <span>
                        {mailCheck.students.length === 1
                            ? `Checking ${mailCheck.students[0]!.name}'s mailbox…`
                            : `Checking ${mailCheck.students.length} mailboxes…`}
                    </span>
                </div>
            )}

            {mailCheck?.phase === "done" && (
                <div className="mail-check done">
                    <span>
                        ✓ {mailCheck.students.length === 1 ? "Mailbox" : "Mailboxes"} checked{" "}
                        {checkedAgo(mailCheck.checkedAt)}:{" "}
                        {mailCheck.added === 0
                            ? "nothing missing. If an email is still expected, it hasn't reached the mailbox yet."
                            : `${mailCheck.added} missing email${mailCheck.added === 1 ? "" : "s"} added`}
                    </span>
                    <button
                        className="mail-check-again"
                        onClick={() => runMailCheck(mailCheck.students, true)}
                    >
                        Check again
                    </button>
                </div>
            )}

            <FilterButtons filter={filter} counts={counts} onChange={setFilter} />
            </div>
            <CodeAlerts
                refreshKey={alertsRefreshKey}
                onOpen={setSelectedId}
                onShowOlder={() => setFilter("code_expired")}
            />
            </div>
            </div>

            {error && <p className="error" role="alert">{error} <button className="mail-check-again" onClick={() => loadMessages(status, debouncedSearch, filter)}>Retry</button></p>}

            <div className={`main-layout${selectedId !== null ? " has-selection" : ""}`}>
                <div className="list-pane" aria-label="Messages" aria-busy={loading}>
                    <div className="pane-heading">
                        <strong>Messages</strong>
                        <span role="status">{loading ? "Updating…" : `${threads.length}${hasMore ? "+" : ""} conversations`}</span>
                    </div>
                    {loading && threads.length === 0 ? (
                        <div className="list-skeleton" aria-label="Loading">
                            {[0, 1, 2, 3, 4, 5].map((i) => (
                                <div className="skeleton-row" key={i}>
                                    <span className="skeleton-bar" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
                                    <span className="skeleton-bar short" />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <>
                            <MessageList
                                emptyText={EMPTY_TEXT[filter ?? "all"]}
                                threads={threads}
                                selectedId={selectedId}
                                onSelect={(id) => {
                                    setThreadError(null);
                                    setSelectedId(id);
                                }}
                            />
                            {hasMore && (
                                <button
                                    className="load-more-button"
                                    onClick={loadMore}
                                    disabled={loadingMore || loading}
                                >
                                    {loadingMore ? "Loading..." : "Load more"}
                                </button>
                            )}
                        </>
                    )}
                </div>

                <div className="detail-pane" aria-label="Message details">
                    <button className="secondary-button thread-back" onClick={() => setSelectedId(null)}>← Back to messages</button>
                    {selectedId !== null && threadError && <p className="error" role="alert">{threadError} <button className="mail-check-again" onClick={() => selectedId !== null && loadThread(selectedId)}>Retry</button></p>}
                    {selectedId !== null && loadedThreadId === selectedId && threadItems ? (
                        <ThreadView
                            studentName={threads.find((t) => t.threadId === selectedId)?.student_name ?? null}
                            studentAppNo={threads.find((t) => t.threadId === selectedId)?.student_app_no ?? null}
                            key={selectedId}
                            items={threadItems}
                            onReplySent={handleReplySent}
                        />
                    ) : selectedId !== null ? (
                        !threadError && <div className="detail-loading" role="status" aria-label="Loading message">
                            <span className="skeleton-bar" style={{ width: "60%" }} />
                            <span className="skeleton-bar short" />
                            <span className="skeleton-bar skeleton-block" />
                        </div>
                    ) : (
                        <div className="detail-empty">
                            <strong>Select a conversation</strong>
                            <p>View student details, registration updates, and replies here.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default Console;
