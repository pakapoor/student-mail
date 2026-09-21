import { useEffect, useState } from "react";
import { fetchColleges } from "./api";
import type { College } from "./types";

export default function CollegePicker({ onSelect }: { onSelect: (college: College) => void }) {
    const [colleges, setColleges] = useState<College[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);

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

    return <main className="login-page">
        <section className="login-card college-picker" aria-labelledby="college-picker-title">
            <p className="brand-name">ISM Edutech</p>
            <h1 id="college-picker-title">Choose your college</h1>
            <p className="login-subtitle">Select a college to sign in to the Student Mail Console.</p>
            {loading ? <p role="status">Loading colleges...</p> : error ? <>
                <p className="error" role="alert">Unable to load colleges.</p>
                <button className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
            </> : colleges.length === 0 ? <p>No colleges are configured yet.</p> :
                <div className="college-options">{colleges.map((college) =>
                    <button key={college.id} className="college-option" onClick={() => onSelect(college)}>
                        {college.name}<span aria-hidden="true">→</span>
                    </button>
                )}</div>
            }
        </section>
    </main>;
}
