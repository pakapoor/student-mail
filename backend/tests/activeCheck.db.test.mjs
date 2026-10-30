// Step 53 (owner): students in progress are checked every 5 min, capped at
// 600 checks an hour (activeCheck.ts). Pure rules first, then who counts as
// "active" against a real PostgreSQL.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, builders } from './helpers/testdb.mjs';

const t = await startTestDb();
const skip = t ? false : 'no PostgreSQL server binaries available';
after(() => t?.stop());

if (t) mock.module('../src/db.ts', { exports: { db: t.pool } });
const broadcasts = [];
mock.module('../src/realtime.ts', { exports: { broadcast: (...a) => broadcasts.push(a), addClient() {}, removeClient() {} } });
const active = await import('../src/activeCheck.ts');
const b = t ? builders(t.pool) : null;

const MIN = 60 * 1000;
const ids = (list) => list.map(s => s.id);

beforeEach(async () => {
    active.resetActiveCheck();
    broadcasts.length = 0;
    if (t) await t.reset();
});

// --- Pure rules ---------------------------------------------------------------

test('20 active students: every 5 min (well under the cap)', () => {
    assert.equal(active.activeInterval(20, 5 * MIN, 600), 5 * MIN);
});

test('50 active students: exactly 600 an hour, still every 5 min', () => {
    assert.equal(active.activeInterval(50, 5 * MIN, 600), 5 * MIN);
});

test('51 active students: the interval stretches just past 5 min', () => {
    assert.ok(active.activeInterval(51, 5 * MIN, 600) > 5 * MIN);
});

test('125 active (after a bulk add): about every 12.5 min', () => {
    assert.equal(active.activeInterval(125, 5 * MIN, 600), 12.5 * MIN);
});

test('the hourly cap holds for any number of students', () => {
    for (const n of [1, 10, 49, 50, 51, 100, 333, 1000]) {
        const perHour = n * (60 * MIN) / active.activeInterval(n, 5 * MIN, 600);
        assert.ok(perHour <= 600 + 1e-9, `${n} students -> ${perHour}/h`);
    }
});

test('no active students or a zero cap: the base interval, no division by zero', () => {
    assert.equal(active.activeInterval(0, 5 * MIN, 600), 5 * MIN);
    assert.equal(active.activeInterval(10, 5 * MIN, 0), 5 * MIN);
});

test('per-minute limit keeps one minute under the hourly cap', () => {
    assert.equal(active.perTickLimit(600, MIN), 10);
    assert.equal(active.perTickLimit(60, MIN), 1);
    assert.equal(active.perTickLimit(1, MIN), 1, 'never zero');
});

test('pickDue: never-checked students first, then the most overdue', () => {
    const students = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const last = new Map([['1', 1000], ['2', 500]]);
    assert.deepEqual(ids(active.pickDue(students, last, 10 * MIN, 5 * MIN, 10)), ['3', '2', '1']);
});

test('pickDue: students checked within the interval are not due', () => {
    const last = new Map([['1', 10 * MIN - 4 * MIN]]);
    assert.deepEqual(ids(active.pickDue([{ id: '1' }], last, 10 * MIN, 5 * MIN, 10)), []);
});

test('pickDue: exactly at the interval is due', () => {
    const last = new Map([['1', 5 * MIN]]);
    assert.deepEqual(ids(active.pickDue([{ id: '1' }], last, 10 * MIN, 5 * MIN, 10)), ['1']);
});

test('pickDue: at most perTick students, the most overdue ones', () => {
    const students = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1) }));
    const last = new Map(students.map((s, i) => [s.id, i * 1000]));
    assert.deepEqual(ids(active.pickDue(students, last, 60 * MIN, 5 * MIN, 3)), ['1', '2', '3']);
});

test('pickDue: ties broken by id, stable', () => {
    assert.deepEqual(ids(active.pickDue([{ id: '10' }, { id: '2' }], new Map(), 0, 5 * MIN, 5)), ['2', '10']);
});

test('pickDue: perTick 0 or negative picks nobody', () => {
    assert.deepEqual(active.pickDue([{ id: '1' }], new Map(), 0, 1, 0), []);
    assert.deepEqual(active.pickDue([{ id: '1' }], new Map(), 0, 1, -3), []);
});

// --- Who is active (real PostgreSQL) -------------------------------------------

const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * MIN);
const addedAt = (email, when) => t.pool.query('UPDATE students SET created_at = $2 WHERE email = $1', [email, when]);

test('a student added in the last 14 days and not registered is active', { skip }, async () => {
    const s = await b.student();
    assert.deepEqual((await active.findActiveStudents()).map(r => r.email), [s]);
});

test('a student added 15 days ago with no Edugate mail is not active', { skip }, async () => {
    const s = await b.student();
    await addedAt(s, daysAgo(15));
    assert.deepEqual(await active.findActiveStudents(), []);
});

test('an older student with an Edugate email in the last 7 days is active', { skip }, async () => {
    const s = await b.student();
    await addedAt(s, daysAgo(60));
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'code', at: daysAgo(2) });
    assert.deepEqual((await active.findActiveStudents()).map(r => r.email), [s]);
});

test('Edugate mail older than 7 days does not make a student active', { skip }, async () => {
    const s = await b.student();
    await addedAt(s, daysAgo(60));
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'code', at: daysAgo(8) });
    assert.deepEqual(await active.findActiveStudents(), []);
});

test('an Edugate notice without a kind (notify@edu.gov.kg) still counts', { skip }, async () => {
    const s = await b.student();
    await addedAt(s, daysAgo(60));
    await b.message({ student: s, sender: 'notify@edu.gov.kg', at: daysAgo(1) });
    assert.equal((await active.findActiveStudents()).length, 1);
});

test('ordinary (non-Edugate) mail does not make an older student active', { skip }, async () => {
    const s = await b.student();
    await addedAt(s, daysAgo(60));
    await b.message({ student: s, sender: 'parent@example.test', at: daysAgo(1) });
    assert.deepEqual(await active.findActiveStudents(), []);
});

test('registered students are never active', { skip }, async () => {
    await b.student({ registeredAt: new Date() });
    assert.deepEqual(await active.findActiveStudents(), []);
});

test('deleted students and students not confirmed yet are never active', { skip }, async () => {
    await b.student({ deleted: true });
    const hidden = await b.student();
    await t.pool.query('UPDATE students SET mailbox_confirmed_at = NULL WHERE email = $1', [hidden]);
    assert.deepEqual(await active.findActiveStudents(), []);
});

test('students without a password are skipped', { skip }, async () => {
    const s = await b.student();
    await t.pool.query("UPDATE students SET smtp_password = '' WHERE email = $1", [s]);
    assert.deepEqual(await active.findActiveStudents(), []);
});

// --- A round -------------------------------------------------------------------

test('a round checks every active student once, then nobody until 5 min later', { skip }, async () => {
    await b.student(); await b.student(); await b.student();
    const checked = [];
    const check = async (s) => { checked.push(s.email); return { status: 'ok', checked: 1, added: 0 }; };
    const now = Date.now();
    assert.deepEqual(await active.activeTick(now, check), { active: 3, checked: 3 });
    assert.deepEqual((await active.activeTick(now + 4 * MIN, check)).checked, 0);
    assert.deepEqual((await active.activeTick(now + 5 * MIN, check)).checked, 3);
    assert.equal(checked.length, 6);
});

test('a round uses the "active" source and forces a fresh check', { skip }, async () => {
    await b.student();
    const calls = [];
    await active.activeTick(Date.now(), async (...args) => { calls.push(args); return { status: 'ok', checked: 0, added: 0 }; });
    assert.equal(calls[0][2], true, 'force');
    assert.equal(calls[0][3], 'active');
});

test('recovered mail is announced to the consoles', { skip }, async () => {
    await b.student();
    await active.activeTick(Date.now(), async () => ({ status: 'ok', checked: 1, added: 2 }));
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0][1].inserted, 2);
    assert.deepEqual(active.activeStats().recovered, 2);
});

test('a failed mailbox check is counted, does not stop the others', { skip }, async () => {
    await b.student(); await b.student();
    let n = 0;
    const r = await active.activeTick(Date.now(), async () => (n++ === 0 ? { status: 'failed', reason: 'timeout' } : { status: 'ok', checked: 0, added: 0 }));
    assert.equal(r.checked, 2);
    assert.equal(active.activeStats().failed, 1);
});

test('at most 10 checks in one round, even with many active students', { skip }, async () => {
    for (let i = 0; i < 25; i++) await b.student();
    const r = await active.activeTick(Date.now(), async () => ({ status: 'ok', checked: 0, added: 0 }));
    assert.equal(r.active, 25);
    assert.equal(r.checked, 10);
});
