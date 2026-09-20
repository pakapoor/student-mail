import { useEffect, useState } from "react";
import { fetchStudents, importStudents } from "./api";
import type { ImportResult, StudentRow } from "./types";

interface Props {
    onClose: () => void;
    onImported: () => void;
}

export default function ManageStudents({ onClose, onImported }: Props) {
    const [students, setStudents] = useState<StudentRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [csv, setCsv] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<ImportResult | null>(null);

    function loadStudents() {
        setLoading(true);
        fetchStudents()
            .then(setStudents)
            .catch((err) =>
                setError(err instanceof Error ? err.message : "Failed to load students")
            )
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        loadStudents();
    }, []);

    async function handleImport() {
        setError(null);
        setResult(null);
        setSubmitting(true);

        try {
            const res = await importStudents(csv);
            setResult(res);
            setCsv("");
            loadStudents();
            onImported();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Import failed");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Manage students</h2>
                    <button className="modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>

                <div className="import-section">
                    <h3>Add students</h3>
                    <p className="hint-text">
                        One student per line: <code>name,email,password</code> (the
                        password is that student's Migadu mailbox password, used for
                        sending replies). Same format as the Migadu CSV - extra columns
                        are ignored.
                    </p>

                    <textarea
                        rows={6}
                        placeholder={
                            "Jane Doe,jane.doe@pilot.system-design.in,S3cret!\n" +
                            "John Roe,john.roe@pilot.system-design.in,S3cret!"
                        }
                        value={csv}
                        onChange={(e) => setCsv(e.target.value)}
                        disabled={submitting}
                    />

                    {error && <p className="error">{error}</p>}

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
                                {result.imported} added, {result.updated} updated,{" "}
                                {result.rejected.length} rejected.
                            </p>
                            {result.rejected.length > 0 && (
                                <ul className="rejected-list">
                                    {result.rejected.map((r) => (
                                        <li key={r.line}>
                                            Line {r.line} ({r.email}): {r.reason}
                                            {r.owner ? ` - owned by ${r.owner}` : ""}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>

                <div className="roster-section">
                    <h3>Current students ({students.length})</h3>

                    {loading ? (
                        <p className="empty-state">Loading...</p>
                    ) : students.length === 0 ? (
                        <p className="empty-state">
                            No students assigned to this mailbox yet.
                        </p>
                    ) : (
                        <ul className="roster-list">
                            {students.map((s) => (
                                <li key={s.id}>
                                    <span className="roster-name">{s.name || "(no name)"}</span>
                                    <span className="roster-email">{s.email}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}
