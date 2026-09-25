import type { ThreadFilter, ThreadSummaryPage } from "./api";

// Filter buttons under the search box (Step 18). One filter at a time; the
// counts come with every list load, for the current search. Three ways back
// to the full list, because staff miss small controls: the "All" button
// (outlined in blue whenever a filter is on), the ✕ on the pressed button,
// or clicking the pressed button again.

const BUTTONS: { filter: ThreadFilter; label: string; dot: string }[] = [
    { filter: "code_live", label: "Code received", dot: "live" },
    { filter: "code_expired", label: "Code expired", dot: "expired" },
    { filter: "registered", label: "Registered", dot: "registered" },
    { filter: "rejected", label: "Rejected", dot: "rejected" },
    { filter: "other", label: "Other emails", dot: "other" },
];

interface Props {
    filter: ThreadFilter | null;
    counts: ThreadSummaryPage["counts"] | null;
    onChange: (filter: ThreadFilter | null) => void;
}

export default function FilterButtons({ filter, counts, onChange }: Props) {
    return (
        <div className="filter-buttons" role="group" aria-label="Filter threads">
            <button
                type="button"
                className={filter === null ? "filter-chip all active" : "filter-chip all"}
                onClick={() => onChange(null)}
            >
                {filter === null ? "All" : "← All"}
                {counts && <span className="filter-count">{counts.all}</span>}
            </button>

            {BUTTONS.map((b) => {
                const active = filter === b.filter;

                return (
                    <button
                        key={b.filter}
                        type="button"
                        className={[
                            "filter-chip",
                            b.dot,
                            active ? "active" : "",
                            filter !== null && !active ? "dim" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        aria-pressed={active}
                        onClick={() => onChange(active ? null : b.filter)}
                    >
                        {!active && <span className={`filter-dot ${b.dot}`} />}
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
