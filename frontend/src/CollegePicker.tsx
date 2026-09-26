import { useEffect, useState } from "react";
import { fetchColleges, selectCollege } from "./api";
import { collegeLogo, ISM_EDUTECH_LOGO } from "./branding";
import type { College, Session } from "./types";

export default function CollegePicker({ onSelect }: { onSelect: (session: Session) => void }) {
    const [colleges, setColleges] = useState<College[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [selecting, setSelecting] = useState<string | null>(null);
    const [selectError, setSelectError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError(false);
        fetchColleges()
            .then((rows) => { if (active) setColleges(rows); })
            .catch(() => { if (active) setError(true); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [attempt]);

    async function handleSelect(college: College) {
        setSelecting(college.id);
        setSelectError(null);

        try {
            const session = await selectCollege(college.id);
            onSelect(session);
        } catch (err) {
            setSelectError(err instanceof Error ? err.message : "Failed to select college");
            setSelecting(null);
        }
    }

    return <main className="login-page">
        <section className="login-card college-picker" aria-labelledby="college-picker-title">
            <img className="brand-logo" src={ISM_EDUTECH_LOGO} alt="ISM Edutech" />
            <h1 id="college-picker-title">Choose your college</h1>
            <p className="login-subtitle">Select a college to sign in to the Student Mail Console.</p>
            {loading ? <p role="status">Loading colleges...</p> : error ? <>
                <p className="error" role="alert">Unable to load colleges.</p>
                <button className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
            </> : colleges.length === 0 ? <p>No colleges are configured yet.</p> :
                <div className="college-options">{colleges.map((college) => {
                    const logo = collegeLogo(college.name);
                    return (
                        <button
                            key={college.id}
                            className="college-option"
                            onClick={() => handleSelect(college)}
                            disabled={selecting !== null}
                            aria-busy={selecting === college.id}
                        >
                            {logo && <img className="college-option-logo" src={logo} alt="" />}
                            <span className="college-option-name">{college.name}</span>
                            {selecting === college.id ? <span className="spinner spinner-dark" aria-hidden="true" /> : <span aria-hidden="true">→</span>}
                        </button>
                    );
                })}</div>
            }
            {selecting && <p className="college-progress" role="status">Opening {colleges.find((college) => college.id === selecting)?.name}…</p>}
            {selectError && <p className="error" role="alert">{selectError}</p>}
        </section>
    </main>;
}
