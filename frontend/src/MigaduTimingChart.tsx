import { useEffect, useRef, useState } from "react";

// Status page (Step 43): how long calls to the Migadu mailbox API take, one mark
// per hour over the last 7 days. The dot is that hour's median call, the bar
// above it reaches the slowest call of the hour; a red cap means at least one
// call in that hour did not end ok. The dashed line is the timeout in force,
// shown when it is within reach of the data (otherwise it is named under the chart).

export interface HourPoint {
    at: string;
    calls: number;
    medianMs: number;
    slowestMs: number;
    notOk: number;
}

const HEIGHT = 190;
const PAD = { top: 14, right: 16, bottom: 24, left: 44 };

function seconds(ms: number): string {
    return ms >= 10000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;
}

function when(t: number): string {
    return new Date(t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export default function MigaduTimingChart({ hours, timeoutMs }: { hours: HourPoint[]; timeoutMs: number }) {
    const box = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(600);

    useEffect(() => {
        const el = box.current;

        if (!el) {
            return;
        }

        const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry!.contentRect.width)));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    if (hours.length === 0) {
        return null;
    }

    const dayMs = 24 * 60 * 60 * 1000;
    const t1 = Date.now();
    const t0 = t1 - 7 * dayMs;
    const slowestOverall = Math.max(...hours.map((h) => h.slowestMs));
    const yMax = Math.max(2000, slowestOverall * 1.15);
    const showTimeout = timeoutMs <= yMax * 1.05;
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * plotW;
    const y = (ms: number) => PAD.top + plotH - (Math.min(ms, yMax) / yMax) * plotH;

    const step = yMax <= 4000 ? 1000 : yMax <= 12000 ? 2000 : 5000;
    const grid: number[] = [];

    for (let v = 0; v <= yMax; v += step) {
        grid.push(v);
    }

    // A label at the start of each of the last 7 days.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const dayTicks: number[] = [];

    for (let d = 6; d >= 0; d--) {
        const t = midnight.getTime() - d * dayMs;

        if (t >= t0) {
            dayTicks.push(t);
        }
    }

    return (
        <div ref={box} className="migadu-chart">
            <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="img" aria-label="Migadu call times over the last 7 days">
                {grid.map((v) => (
                    <g key={v}>
                        <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="migadu-grid" />
                        <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="migadu-axis">
                            {v / 1000} s
                        </text>
                    </g>
                ))}

                {dayTicks.map((t) => (
                    <text key={t} x={x(t)} y={HEIGHT - 6} className="migadu-axis">
                        {new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric" })}
                    </text>
                ))}

                {showTimeout && (
                    <g>
                        <line x1={PAD.left} x2={width - PAD.right} y1={y(timeoutMs)} y2={y(timeoutMs)} className="migadu-timeout" />
                        <text x={width - PAD.right} y={y(timeoutMs) - 4} textAnchor="end" className="migadu-axis">
                            timeout {seconds(timeoutMs)}
                        </text>
                    </g>
                )}

                {hours.map((h) => {
                    const px = x(new Date(h.at).getTime());
                    const bad = h.notOk > 0;
                    return (
                        <g key={h.at}>
                            <title>{`${when(new Date(h.at).getTime())}: ${h.calls} call${h.calls === 1 ? "" : "s"}, median ${seconds(h.medianMs)}, slowest ${seconds(h.slowestMs)}${bad ? `, ${h.notOk} not ok` : ""}`}</title>
                            <line x1={px} x2={px} y1={y(h.medianMs)} y2={y(h.slowestMs)} className="migadu-range" />
                            <circle cx={px} cy={y(h.slowestMs)} r={bad ? 3.5 : 2.5} className={bad ? "migadu-cap bad" : "migadu-cap"} />
                            <circle cx={px} cy={y(h.medianMs)} r={3} className="migadu-median" />
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}
