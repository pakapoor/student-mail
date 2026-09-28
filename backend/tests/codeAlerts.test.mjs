import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Pure rules only - no database.
mock.module('../src/db.ts', { exports: { db: { query: async () => ({ rows: [] }) } } });
const { analyzeCodes, pickAlerts, summarizeCodes } = await import('../src/codeAlerts.ts');

const MIN = 60000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
let nextId = 1;
const code = (email, minutesAgo, extra = {}) => ({
    id: nextId++, email, at: NOW - minutesAgo * MIN, validMinutes: 30, heldSeconds: null, name: null, appNo: null, ...extra,
});
const logins = entries => new Map(entries.map(([email, minutesAgo]) => [email, [NOW - minutesAgo * MIN]]));
const states = r => r.alerts.map(a => `${a.email}:${a.state}`);

test('amber in the last 5 minutes, red once expired, nothing while fresh', () => {
    const out = analyzeCodes([code('fresh@x', 10), code('amber@x', 27), code('red@x', 40)], new Map());
    assert.deepEqual(states(pickAlerts(out, NOW)), ['amber@x:expiring', 'red@x:expired']);
});

test('a registration email within validity + 5 min grace clears the code', () => {
    const out = analyzeCodes([code('late@x', 33), code('used@x', 40)], logins([['late@x', 0], ['used@x', 20]]));
    assert.deepEqual(pickAlerts(out, NOW).alerts, []);
});

test('a newer code before expiry is not a miss; one after expiry handles it', () => {
    const early = [code('a@x', 40), code('a@x', 20)]; // replaced before expiry: old one never expired unused
    const late = [code('b@x', 90), code('b@x', 20)]; // expired at 60 min ago, fresh code 40 min after
    const out = analyzeCodes([...early, ...late], new Map());
    assert.deepEqual(pickAlerts(out, NOW).alerts, []);
    const today = summarizeCodes(out, NOW, 'UTC').days.at(-1);
    assert.equal(today.expiredUnused, 1);
    assert.equal(today.handled, 1);
    assert.equal(today.medianMinutesToFreshCode, 40);
});

test('fewer than 5 open expiries stay up to 24 h; 5 or more show only the last 30 min', () => {
    const four = analyzeCodes(['a', 'b', 'c', 'd'].map((n, i) => code(`${n}@x`, 120 + i * 60)), new Map());
    assert.equal(pickAlerts(four, NOW).alerts.length, 4);
    assert.equal(pickAlerts(four, NOW).olderExpired, 0);

    const five = analyzeCodes([code('new@x', 45), ...['a', 'b', 'c', 'd'].map((n, i) => code(`${n}@x`, 120 + i * 60))], new Map());
    const r = pickAlerts(five, NOW);
    assert.deepEqual(states(r), ['new@x:expired']);
    assert.equal(r.olderExpired, 4);

    const stale = analyzeCodes([code('old@x', 25 * 60)], new Map());
    assert.deepEqual(pickAlerts(stale, NOW).alerts, []);
});

test('status: running count every 5 min over 6 h, recent entries, warning, Migadu tag', () => {
    const out = analyzeCodes([
        code('w@x', 40, { name: 'TANISHA SHARMA', heldSeconds: 1200 }), // expired 11:50, still waiting
        code('h@x', 120), code('h@x', 20), // expired 10:30, fresh code 11:40
    ], new Map());
    const s = summarizeCodes(out, NOW, 'UTC');
    const at = iso => s.timeline.points.find(p => p.at === iso)?.waiting;
    assert.equal(s.timeline.stepMinutes, 5);
    assert.equal(s.timeline.points.length, 72); // 06:05 … 11:55, then now (12:00)
    assert.equal(at('2026-09-26T10:15:00.000Z'), 0);
    assert.equal(at('2026-09-26T10:30:00.000Z'), 1);
    assert.equal(at('2026-09-26T11:30:00.000Z'), 1);
    assert.equal(at('2026-09-26T11:45:00.000Z'), 0);
    assert.equal(s.timeline.points.at(-1).waiting, 1);
    assert.equal(s.days.length, 7);
    assert.equal(s.days.at(-1).migaduDelayed, 1);
    assert.match(s.recent[0].details, /TANISHA SHARMA \(w@x\) · no fresh code yet · code email held 20 min by Migadu/);
    assert.equal(s.recent[0].state, 'open');
    assert.equal(s.recent[0].solvedAt, null);
    assert.equal(s.recent[1].state, 'solved'); // h@x got a fresh code at 11:40
    assert.equal(s.recent[1].solvedAt, '2026-09-26T11:40:00.000Z');
    assert.match(s.warning, /2 verification codes expired unused today; 1 still waiting/);
});
