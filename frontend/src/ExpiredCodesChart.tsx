import { useEffect, useRef, useState } from "react";

// Status page (Step 27): how many expired codes were waiting for a fresh
// code, every 5 min over the last 6 h - a fixed sliding window (user:
// "whats gone is gone"), one smooth line, deliberately plain.

interface Point {
    at: string;
    waiting: number;
}

const HEIGHT = 170;
const PAD = { top: 16, right: 36, bottom: 24, left: 28 };

function clock(t: number): string {
    const d = new Date(t);
    const h = d.getHours();
    return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? " AM" : " PM"}`;
}

function clockMinutes(t: number): string {
    const d = new Date(t);
    const h = d.getHours();
    return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// Monotone cubic (Fritsch-Carlson): smooth, but never overshoots below 0 or
// above a real value between two points.
function smoothPath(xs: number[], ys: number[]): string {
    const n = xs.length;

    if (n === 0) {
        return "";
    }

    if (n === 1) {
        return `M${xs[0]},${ys[0]}`;
    }

    const d: number[] = [];
    const m: number[] = [];

    for (let i = 0; i < n - 1; i++) {
        d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
    }

    m.push(d[0]!);

    for (let i = 1; i < n - 1; i++) {
        m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
    }

    m.push(d[n - 2]!);

    for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) {
            m[i] = 0;
            m[i + 1] = 0;
            continue;
        }

        const a = m[i]! / d[i]!;
        const b = m[i + 1]! / d[i]!;
        const s = a * a + b * b;

        if (s > 9) {
            const t = 3 / Math.sqrt(s);
            m[i] = t * a * d[i]!;
            m[i + 1] = t * b * d[i]!;
        }
    }

    let path = `M${xs[0]},${ys[0]}`;

    for (let i = 0; i < n - 1; i++) {
        const h = (xs[i + 1]! - xs[i]!) / 3;
        path += ` C${xs[i]! + h},${ys[i]! + m[i]! * h} ${xs[i + 1]! - h},${ys[i + 1]! - m[i + 1]! * h} ${xs[i + 1]},${ys[i + 1]}`;
    }

    return path;
}

export default function ExpiredCodesChart({ points }: { points: Point[] }) {
    const box = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(600);
    const [hover, setHover] = useState<number | null>(null);

    useEffect(() => {
        const el = box.current;

        if (!el) {
            return;
        }

        const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry!.contentRect.width)));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    if (points.length === 0) {
        return null;
    }

    const times = points.map((p) => new Date(p.at).getTime());
    const t0 = times[0]!;
    const t1 = times[times.length - 1]!;
    const peak = Math.max(...points.map((p) => p.waiting));
    const yMax = Math.max(2, peak + (peak >= 4 ? 1 : 0));
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
    const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
    const xs = times.map(x);
    const ys = points.map((p) => y(p.waiting));
    const line = smoothPath(xs, ys);
    const baseline = y(0);
    const area = `${line} L${xs[xs.length - 1]},${baseline} L${xs[0]},${baseline} Z`;

    // Up to 3 whole-number gridlines.
    const step = Math.max(1, Math.ceil(yMax / 3));
    const gridValues: number[] = [];

    for (let v = 0; v <= yMax; v += step) {
        gridValues.push(v);
    }

    // A time label on every hour inside the window.
    const hourMs = 60 * 60 * 1000;
    const timeTicks: number[] = [];

    for (let t = Math.ceil(t0 / hourMs) * hourMs; t <= t1; t += hourMs) {
        timeTicks.push(t);
    }

    const current = points[points.length - 1]!.waiting;
    const hovered = hover === null ? null : { x: xs[hover]!, y: ys[hover]!, t: times[hover]!, v: points[hover]!.waiting };

    function onMove(event: React.PointerEvent<SVGSVGElement>) {
        const rect = event.currentTarget.getBoundingClientRect();
        const px = ((event.clientX - rect.left) / rect.width) * width;
        let best = 0;

        for (let i = 1; i < xs.length; i++) {
            if (Math.abs(xs[i]! - px) < Math.abs(xs[best]! - px)) {
                best = i;
            }
        }

        setHover(best);
    }

    return (
        <div className="codes-chart" ref={box}>
            <svg
                width={width}
                height={HEIGHT}
                role="img"
                aria-label={`Expired codes waiting for a fresh code over the last 6 hours. Now: ${current}. Peak: ${peak}.`}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
            >
                {gridValues.map((v) => (
                    <g key={v}>
                        <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="codes-chart-grid" />
                        <text x={PAD.left - 8} y={y(v)} className="codes-chart-axis" textAnchor="end" dominantBaseline="middle">
                            {v}
                        </text>
                    </g>
                ))}
                {timeTicks.map((t) => (
                    <text key={t} x={x(t)} y={HEIGHT - 6} className="codes-chart-axis" textAnchor="middle">
                        {clock(t)}
                    </text>
                ))}
                <path d={area} className="codes-chart-area" />
                <path d={line} className="codes-chart-line" />
                <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={4} className="codes-chart-end" />
                <text x={xs[xs.length - 1]! + 8} y={ys[ys.length - 1]} className="codes-chart-now" dominantBaseline="middle">
                    {current}
                </text>
                {hovered && (
                    <g pointerEvents="none">
                        <line x1={hovered.x} x2={hovered.x} y1={PAD.top} y2={baseline} className="codes-chart-cross" />
                        <circle cx={hovered.x} cy={hovered.y} r={4} className="codes-chart-end" />
                    </g>
                )}
            </svg>
            {hovered && (
                <div
                    className="codes-chart-tip"
                    style={{ left: Math.min(Math.max(hovered.x, 70), width - 70), top: Math.max(hovered.y - 40, 0) }}
                >
                    <b>{hovered.v}</b> waiting · {clockMinutes(hovered.t)}
                </div>
            )}
        </div>
    );
}
