import { useCallback, useEffect, useRef, useState } from "react";
import {
    fetchStudents,
    fetchThread,
    fetchThreadSummaries,
    logout,
    subscribeToUpdates,
} from "./api";
import MessageList from "./MessageList";
import ThreadView from "./ThreadView";
import ManageStudents from "./ManageStudents";
import type { StatusFilter, ThreadItem, ThreadSummary } from "./types";

const TABS: StatusFilter[] = ["pending", "replied"];

interface Props {
    email: string;
    onLoggedOut: () => void;
}

function Console({ email, onLoggedOut }: Props) {
    const [status, setStatus] = useState<StatusFilter>("pending");
    const [threads, setThreads] = useState<ThreadSummary[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [threadItems, setThreadItems] = useState<ThreadItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showManageStudents, setShowManageStudents] = useState(false);

    const loadMessages = useCallback(async (statusFilter: StatusFilter) => {
        setLoading(true);
        setError(null);

        try {
            const page = await fetchThreadSummaries(statusFilter, 0);
            setThreads(page.threads);
            setHasMore(page.hasMore);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load messages");
        } finally {
            setLoading(false);
        }
    }, []);

    const loadMore = useCallback(async () => {
        setLoadingMore(true);
        setError(null);

        try {
            const page = await fetchThreadSummaries(status, threads.length);
            setThreads((prev) => [...prev, ...page.threads]);
            setHasMore(page.hasMore);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load more");
        } finally {
            setLoadingMore(false);
        }
    }, [status, threads.length]);

    const loadThread = useCallback((id: number) => {
        fetchThread(id)
            .then(setThreadItems)
            .catch((err) =>
                setError(err instanceof Error ? err.message : "Failed to load thread")
            );
    }, []);

    useEffect(() => {
        loadMessages(status);
        setSelectedId(null);
        setThreadItems(null);
    }, [status, loadMessages]);

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

    useEffect(() => {
        statusRef.current = status;
    }, [status]);

    useEffect(() => {
        selectedIdRef.current = selectedId;
    }, [selectedId]);

    useEffect(() => {
        return subscribeToUpdates(() => {
            // A new-mail sync or any operator's reply/mark-handled action
            // changes the pending set - reload from the top so everyone's
            // view (list + open thread) stays consistent with the server.
            loadMessages(statusRef.current);

            if (selectedIdRef.current !== null) {
                loadThread(selectedIdRef.current);
            }
        });
    }, [loadMessages, loadThread]);

    function handleReplySent() {
        loadMessages(status);

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
                <h1>Student Mail Console</h1>
                <div className="session-bar">
                    <span>{email}</span>
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
                    onClose={() => setShowManageStudents(false)}
                    onImported={() => loadMessages(status)}
                />
            )}

            <nav className="tabs">
                {TABS.map((tab) => (
                    <button
                        key={tab}
                        className={tab === status ? "tab active" : "tab"}
                        onClick={() => setStatus(tab)}
                    >
                        {tab[0].toUpperCase() + tab.slice(1)}
                    </button>
                ))}
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
