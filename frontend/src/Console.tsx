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
} from "./api";
import MessageList from "./MessageList";
import ThreadView from "./ThreadView";
import ManageStudents from "./ManageStudents";
import { collegeLogo, ISM_EDUTECH_LOGO } from "./branding";
import type { College, StatusFilter, ThreadItem, ThreadSummary } from "./types";

const TABS: StatusFilter[] = ["pending", "replied"];
// "replied" is kept as the internal status value (matches the DB column and
// API param) - only the user-facing label changed from "Replied" to
// "Closed" per the customer's request.
const TAB_LABELS: Record<StatusFilter, string> = { pending: "Pending", replied: "Closed" };

type MailCheckState =
    | { phase: "checking"; students: MailCheckStudent[] }
    | { phase: "done"; students: MailCheckStudent[]; added: number; checkedAt: number }
    | { phase: "tooMany" };

function checkedAgo(checkedAt: number): string {
    const minutes = Math.floor((Date.now() - checkedAt) / 60000);
    return minutes < 1 ? "just now" : `${minutes} min ago`;
}

interface Props {
    college: College;
    onLoggedOut: () => void;
}

function Console({ college, onLoggedOut }: Props) {
    const [status, setStatus] = useState<StatusFilter>("pending");
    const [threads, setThreads] = useState<ThreadSummary[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [threadItems, setThreadItems] = useState<ThreadItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showManageStudents, setShowManageStudents] = useState(false);
    const [pendingCount, setPendingCount] = useState(0);
    const [closedCount, setClosedCount] = useState<number | null>(null);

    // Single search box shared across both tabs - the same term stays
    // applied when switching Pending/Closed, so a user unsure which tab a
    // thread landed in doesn't have to retype anything (per the customer's
    // own framing of that workflow).
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");

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

    const loadMessages = useCallback(async (statusFilter: StatusFilter, searchText: string) => {
        setLoading(true);
        setError(null);

        try {
            const page = await fetchThreadSummaries(statusFilter, 0, undefined, searchText);
            setThreads(page.threads);
            setHasMore(page.hasMore);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load messages");
        } finally {
            setLoading(false);
        }
    }, []);

    // Kept in sync independently of whichever tab is active, so the Pending
    // tab can always show a live count - the main workflow this console
    // supports, per the customer's own framing of typical usage. While
    // searching, the Closed count is also fetched so both tabs show how many
    // matches exist there, since the user may not know which tab a thread is in.
    const loadPendingCount = useCallback(async (searchText: string) => {
        try {
            const page = await fetchThreadSummaries("pending", 0, 1, searchText);
            setPendingCount(page.total);
        } catch {
            // Non-critical - the tab just keeps showing its last known count.
        }

        if (!searchText) {
            setClosedCount(null);
            return;
        }

        try {
            const page = await fetchThreadSummaries("replied", 0, 1, searchText);
            setClosedCount(page.total);
        } catch {
            // Non-critical - the tab just keeps showing its last known count.
        }
    }, []);

    const loadMore = useCallback(async () => {
        setLoadingMore(true);
        setError(null);

        try {
            const page = await fetchThreadSummaries(status, threads.length, undefined, debouncedSearch);
            setThreads((prev) => [...prev, ...page.threads]);
            setHasMore(page.hasMore);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load more");
        } finally {
            setLoadingMore(false);
        }
    }, [status, threads.length, debouncedSearch]);

    const loadThread = useCallback((id: number) => {
        fetchThread(id)
            .then(setThreadItems)
            .catch((err) =>
                setError(err instanceof Error ? err.message : "Failed to load thread")
            );
    }, []);

    useEffect(() => {
        loadMessages(status, debouncedSearch);
        loadPendingCount(debouncedSearch);
        setSelectedId(null);
        setThreadItems(null);
    }, [status, debouncedSearch, loadMessages, loadPendingCount]);

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
                loadMessages(statusRef.current, searchRef.current);
                loadPendingCount(searchRef.current);
            }
        },
        [loadMessages, loadPendingCount]
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
                    setShowManageStudents(true);
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
        return subscribeToUpdates(() => {
            // A new-mail sync or any operator's reply/close action changes
            // the pending set - reload from the top so everyone's view
            // (list + open thread + pending count) stays consistent with
            // the server.
            loadMessages(statusRef.current, searchRef.current);
            loadPendingCount(searchRef.current);

            if (selectedIdRef.current !== null) {
                loadThread(selectedIdRef.current);
            }
        });
    }, [loadMessages, loadPendingCount, loadThread]);

    function handleReplySent() {
        loadMessages(status, debouncedSearch);
        loadPendingCount(debouncedSearch);

        if (selectedId !== null) {
            loadThread(selectedId);
        }
    }

    async function handleLogout() {
        await logout();
        onLoggedOut();
    }

    return (
        <div className="app">
            <header className="app-header">
                <div className="header-brand">
                    <img className="header-logo" src={ISM_EDUTECH_LOGO} alt="ISM Edutech" />
                    {collegeLogo(college.name) && (
                        <img className="header-logo header-college-logo" src={collegeLogo(college.name)} alt="" />
                    )}
                    <div>
                        <h1>Student Mail Console</h1>
                        <p className="console-college">{college.name}</p>
                    </div>
                </div>
                <div className="session-bar">
                    <button
                        className="logout-button"
                        onClick={() => setShowManageStudents(true)}
                    >
                        Manage students
                    </button>
                    <button className="logout-button" onClick={handleLogout}>
                        Log out
                    </button>
                </div>
            </header>

            {showManageStudents && (
                <ManageStudents
                    collegeName={college.name}
                    onClose={() => setShowManageStudents(false)}
                    onImported={() => {
                        loadMessages(status, debouncedSearch);
                        loadPendingCount(debouncedSearch);
                    }}
                />
            )}

            <div className="console-search">
                <input
                    className="admin-search"
                    type="text"
                    placeholder="Search by first name, last name, or email..."
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

            <nav className="tabs">
                {TABS.map((tab) => {
                    // No search: only Pending shows a live count (today's
                    // behavior). While searching, both tabs show their match
                    // count, since the user may not know which tab a thread
                    // landed in (see loadPendingCount).
                    const count =
                        tab === "pending"
                            ? pendingCount
                            : debouncedSearch && closedCount !== null
                              ? closedCount
                              : null;

                    return (
                        <button
                            key={tab}
                            className={tab === status ? "tab active" : "tab"}
                            onClick={() => setStatus(tab)}
                        >
                            {count !== null ? `${TAB_LABELS[tab]} (${count})` : TAB_LABELS[tab]}
                        </button>
                    );
                })}
            </nav>

            {error && <p className="error">{error}</p>}

            <div className="main-layout">
                <div className="list-pane">
                    {loading ? (
                        <p className="empty-state">Loading...</p>
                    ) : (
                        <>
                            <MessageList
                                threads={threads}
                                selectedId={selectedId}
                                onSelect={setSelectedId}
                            />
                            {hasMore && (
                                <button
                                    className="load-more-button"
                                    onClick={loadMore}
                                    disabled={loadingMore}
                                >
                                    {loadingMore ? "Loading..." : "Load more"}
                                </button>
                            )}
                        </>
                    )}
                </div>

                <div className="detail-pane">
                    {threadItems ? (
                        <ThreadView
                            key={selectedId}
                            items={threadItems}
                            onReplySent={handleReplySent}
                        />
                    ) : (
                        <p className="empty-state">Select a message to view the thread.</p>
                    )}
                </div>
            </div>
        </div>
    );
}

export default Console;
