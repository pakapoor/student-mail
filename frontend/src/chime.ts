// Soft two-note chime when new mail arrives for the console's college.
// Generated with Web Audio - no sound file to host. Always on, no setting:
// staff don't use optional controls, so there's nothing to switch.
//
// Browsers only allow sound after the user has clicked/typed on the page
// since it loaded. We unlock on the first such interaction; until then (e.g.
// right after an automatic reload onto a new build) the chime is silent.

const MIN_GAP_MS = 10000;

let context: AudioContext | null = null;
let lastPlayed = 0;

function unlock() {
    try {
        context ??= new AudioContext();
        if (context.state === "suspended") {
            void context.resume();
        }
    } catch {
        // No Web Audio - no chime.
    }
}

for (const event of ["pointerdown", "keydown"]) {
    window.addEventListener(event, unlock, { capture: true });
}

function note(ctx: AudioContext, frequency: number, start: number, duration: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.05);
}

// One chime per burst: a batch of emails arriving together (or several
// syncs in a row) plays once, at most every 10 seconds.
export function playChime() {
    const now = Date.now();

    if (!context || context.state !== "running" || now - lastPlayed < MIN_GAP_MS) {
        return;
    }

    lastPlayed = now;

    try {
        const t = context.currentTime;
        note(context, 880, t, 0.35);
        note(context, 1318.5, t + 0.16, 0.5);
    } catch {
        // Never let a sound problem affect the console.
    }
}
