// Timing of the Migadu API calls (src/migaduTiming.ts) against a real, throwaway
// PostgreSQL: each call is stored and logged, old rows are pruned, and the status
// page figures (median, p95, slowest, hourly points, slowest five) are right.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from './helpers/testdb.mjs';

const t = await startTestDb();
const skip = t ? false : 'no PostgreSQL server binaries available';
after(() => t?.stop());

let timing;
if (t) {
    mock.module('../src/db.ts', { exports: { db: t.pool } });
    timing = await import('../src/migaduTiming.ts');
}

beforeEach(async () => {
    if (t) await t.reset();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
const seed = (operation, ms, outcome, minutesAgo) =>
    t.pool.query("INSERT INTO migadu_calls (at, operation, ms, outcome) VALUES (now() - make_interval(mins => $4), $1, $2, $3)", [operation, ms, outcome, minutesAgo]);

test('a recorded call is stored and written to the log as an [audit] line without any name or password', { skip }, async () => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => { const text = args.join(' '); if (text.startsWith('[audit] ')) lines.push(JSON.parse(text.slice(8))); else original(...args); };
    try {
        timing.recordMigaduCall({ operation: 'create', ms: 812, outcome: 'ok' });
        await tick();
    } finally { console.log = original; }
    const rows = (await t.pool.query('SELECT operation, ms, outcome FROM migadu_calls')).rows;
    assert.deepEqual(rows, [{ operation: 'create', ms: 812, outcome: 'ok' }]);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].event, lines[0].operation, lines[0].ms, lines[0].outcome], ['migadu-call', 'create', 812, 'ok']);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'event', 'ms', 'operation', 'outcome']);
});

test('recording never throws, even when the database is gone', { skip }, async () => {
    await t.pool.query('ALTER TABLE migadu_calls RENAME TO migadu_calls_away');
    try {
        assert.doesNotThrow(() => timing.recordMigaduCall({ operation: 'lookup', ms: 5, outcome: 'ok' }));
        await tick();
    } finally {
        await t.pool.query('ALTER TABLE migadu_calls_away RENAME TO migadu_calls');
    }
});

test('rows older than 30 days are removed, newer ones stay', { skip }, async () => {
    await seed('lookup', 10, 'ok', 31 * 24 * 60);
    await seed('lookup', 10, 'ok', 29 * 24 * 60);
    await seed('lookup', 10, 'ok', 5);
    await timing.pruneOldCalls();
    const left = (await t.pool.query('SELECT count(*)::int AS n FROM migadu_calls')).rows[0].n;
    assert.equal(left, 2);
});

test('with no calls recorded the status has zero figures and no hours', { skip }, async () => {
    const status = await timing.migaduTimingStatus();
    assert.equal(status.timeoutMs, 20000);
    assert.equal(status.windowDays, 7);
    assert.deepEqual(status.summary, { calls: 0, medianMs: null, p95Ms: null, slowestMs: null, notOk: 0, timeouts: 0 });
    assert.deepEqual(status.hours, []);
    assert.deepEqual(status.slowest, []);
});

test('the status figures: median, p95, slowest, calls that did not end ok, timeouts', { skip }, async () => {
    for (const ms of [100, 200, 300, 400, 500, 600, 700, 800, 900]) await seed('lookup', ms, 'ok', 30);
    await seed('create', 20000, 'timeout', 20);
    await seed('create', 450, 'refused', 10);
    const { summary } = await timing.migaduTimingStatus();
    assert.equal(summary.calls, 11);
    assert.equal(summary.slowestMs, 20000);
    assert.equal(summary.notOk, 2);
    assert.equal(summary.timeouts, 1);
    assert.equal(summary.medianMs, 500);
    assert.ok(summary.p95Ms >= 900 && summary.p95Ms <= 20000);
});

test('the last 7 days only: an 8-day-old call is not counted', { skip }, async () => {
    await seed('lookup', 99999, 'ok', 8 * 24 * 60);
    await seed('lookup', 300, 'ok', 5);
    const { summary, slowest } = await timing.migaduTimingStatus();
    assert.equal(summary.calls, 1);
    assert.equal(summary.slowestMs, 300);
    assert.equal(slowest.length, 1);
});

test('hourly points group the calls of one hour, with their median, slowest and not-ok count', { skip }, async () => {
    await seed('lookup', 100, 'ok', 130);
    await seed('create', 500, 'ok', 125);
    await seed('create', 900, 'server-error', 122);
    await seed('lookup', 200, 'ok', 5);
    const { hours } = await timing.migaduTimingStatus();
    assert.ok(hours.length >= 2 && hours.length <= 3, `hours: ${hours.length}`);
    assert.equal(hours.reduce((n, h) => n + h.calls, 0), 4);
    assert.equal(Math.max(...hours.map((h) => h.slowestMs)), 900);
    assert.equal(hours.reduce((n, h) => n + h.notOk, 0), 1);
    assert.deepEqual([...hours].map((h) => h.at), [...hours].map((h) => h.at).sort(), 'oldest first');
});

test('the slowest five are listed, slowest first, with what they were', { skip }, async () => {
    for (const ms of [10, 70, 30, 90, 50, 20, 80]) await seed(ms > 60 ? 'create' : 'lookup', ms, 'ok', 3);
    const { slowest } = await timing.migaduTimingStatus();
    assert.deepEqual(slowest.map((r) => r.ms), [90, 80, 70, 50, 30]);
    assert.deepEqual(slowest.slice(0, 3).map((r) => r.operation), ['create', 'create', 'create']);
});
