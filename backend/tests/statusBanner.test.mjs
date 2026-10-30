// Step 53: the status page is red only when mail is being lost right now,
// amber for patterns, and single-student timeouts are a quiet count
// (systemStatus.ts). Owner: "A HUGE ALERT", "make it simple".
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let query = async () => ({ rows: [] });
mock.module('../src/db.ts', { exports: { db: { query: (...a) => query(...a) } } });
const status = await import('../src/systemStatus.ts');
const jobs = await import('../src/jobHealth.ts');

const MIN = 60 * 1000;
const none = { databaseError: null, crashesLastHour: 0, diskFull: null, lastEmailAt: null };

beforeEach(() => { jobs.resetJobs(); query = async () => ({ rows: [] }); });

test('all fine: green banner saying when the last email arrived', () => {
    const b = status.makeBanner([], { ...none, lastEmailAt: 0 }, 3 * MIN);
    assert.equal(b.level, 'green');
    assert.equal(b.title, 'All good');
    assert.equal(b.detail, 'Last email received 3 min ago.');
});

test('green with no email ever received says so', () => {
    assert.equal(status.makeBanner([], none, 0).detail, 'No email received yet.');
});

test('an outage makes the banner red, with what and for how long (the Oct 28 case: 41 h)', () => {
    const since = 0, now = 41 * 60 * MIN + 7 * MIN;
    const b = status.makeBanner([{ key: 'sync:c', title: 'EMAILS ARE NOT REACHING THE CONSOLE', detail: 'No successful sync of c for 2467 min.', since }], none, now);
    assert.equal(b.level, 'red');
    assert.equal(b.title, 'EMAILS ARE NOT REACHING THE CONSOLE — 41 h 7 min');
    assert.equal(b.since, new Date(0).toISOString());
});

test('several outages: the oldest leads the banner, all details are listed', () => {
    const b = status.makeBanner([
        { key: 'job:b', title: 'B HAS STOPPED', detail: 'B detail.', since: 5 * MIN },
        { key: 'job:a', title: 'A HAS STOPPED', detail: 'A detail.', since: 1 * MIN },
    ], none, 10 * MIN);
    assert.match(b.title, /^A HAS STOPPED — 9 min$/);
    assert.match(b.detail, /B detail\./);
    assert.match(b.detail, /A detail\./);
});

test('database unreachable is red and comes first', () => {
    const b = status.makeBanner([{ key: 'x', title: 'X', detail: 'd', since: 0 }], { ...none, databaseError: 'ECONNREFUSED' }, MIN);
    assert.equal(b.title, 'DATABASE NOT REACHABLE');
    assert.equal(b.detail, 'ECONNREFUSED');
});

test('3 crashes in an hour = crash loop, red', () => {
    assert.match(status.makeBanner([], { ...none, crashesLastHour: 3 }, 0).title, /KEEPS CRASHING — 3 crashes/);
});

test('1 or 2 crashes in an hour stay green (brief blips are fine)', () => {
    assert.equal(status.makeBanner([], { ...none, crashesLastHour: 2 }, 0).level, 'green');
});

test('a nearly full disk is red', () => {
    assert.equal(status.makeBanner([], { ...none, diskFull: 'Disk almost full: 95% used.' }, 0).title, 'DISK ALMOST FULL');
});

test('durations read naturally: minutes, hours, days', () => {
    assert.equal(status.formatDuration(0), '0 min');
    assert.equal(status.formatDuration(59 * MIN), '59 min');
    assert.equal(status.formatDuration(61 * MIN), '1 h 1 min');
    assert.equal(status.formatDuration(47 * 60 * MIN), '47 h 0 min');
    assert.equal(status.formatDuration(50 * 60 * MIN), '2 days 2 h');
    assert.equal(status.formatDuration(-5), '0 min');
});

test('needs a look: 10 central sync failures in an hour (the Oct 25-26 warning sign)', () => {
    assert.equal(status.needsLook(9, []).length, 0);
    assert.match(status.needsLook(10, [])[0], /failed 10 times in the last hour/);
});

test('needs a look: a student mailbox failing for 3 days', () => {
    const lines = status.needsLook(0, ['ann@x']);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ann@x: the mailbox has failed to open for 3 days/);
});

test('current outages include an overdue job but not a healthy one', () => {
    jobs.registerJob('ok', 'OK job', 10 * MIN, Date.now());
    jobs.registerJob('bad', 'Bad job', MIN, Date.now() - 5 * MIN);
    const keys = status.currentOutages(Date.now()).map(o => o.key);
    assert.ok(keys.includes('job:bad'));
    assert.ok(!keys.includes('job:ok'));
});

test('a central mailbox not synced for over 5 min is an outage; under 5 min is not', () => {
    status.noteSyncSuccess('banner@example.test');
    const now = Date.now();
    assert.ok(!status.currentOutages(now + 4 * MIN).some(o => o.key === 'sync:banner@example.test'));
    assert.ok(status.currentOutages(now + 6 * MIN).some(o => o.key === 'sync:banner@example.test'));
    assert.equal(status.SYNC_STALE_MS, 5 * MIN);
});

// --- getSystemStatus with a fake database --------------------------------------

const fakeDb = ({ crashes = [], failing = [], lastEmail = null, fail = false } = {}) => {
    const seen = [];
    query = async (sql, params) => {
        seen.push(sql);
        if (fail) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
        if (sql.includes("kind = 'backend-crash'")) return { rows: crashes };
        if (sql.includes("kind = 'mailbox-failed' AND solved_at IS NULL")) return { rows: failing.map(subject => ({ subject })) };
        if (sql.includes('max(received_at) AS last')) return { rows: [{ last: lastEmail }] };
        if (sql.includes('count(*) AS total')) return { rows: [{ total: '5', today: '2' }] };
        return { rows: [] };
    };
    return seen;
};

test('status: crashes from the database are listed, newest first as stored', async () => {
    fakeDb({ crashes: [{ at: new Date('2026-10-23T06:57:55Z'), detail: 'Down 5 s · error: terminating connection' }] });
    const s = await status.getSystemStatus();
    assert.equal(s.crashes.length, 1);
    assert.match(s.crashes[0].detail, /terminating connection/);
});

test('status: database down makes the banner red "DATABASE NOT REACHABLE"', async () => {
    fakeDb({ fail: true });
    const s = await status.getSystemStatus();
    assert.equal(s.banner.level, 'red');
    assert.equal(s.banner.title, 'DATABASE NOT REACHABLE');
});

test('status: single-student mailbox timeouts are not in the problem list any more', async () => {
    const seen = fakeDb();
    await status.getSystemStatus();
    const recentQuery = seen.find(sql => sql.includes('SELECT at, last_at, times, kind, detail, solved_at'));
    assert.match(recentQuery, /kind NOT IN \('mailbox-failed', 'backend-crash'\)/);
});

test('status: crash records are kept 30 days (not deleted with the 7-day solved rows)', async () => {
    const seen = fakeDb();
    await status.getSystemStatus();
    assert.match(seen.find(sql => sql.includes('DELETE FROM status_problems')), /kind <> 'backend-crash'/);
});

test('status: students failing 3 days become amber "needs a look" lines', async () => {
    fakeDb({ failing: ['ann@x', 'bob@x'] });
    const s = await status.getSystemStatus();
    assert.equal(s.needsLook.length, 2);
});

test('status: the quiet count of single mailbox timeouts is reported', async () => {
    fakeDb();
    status.noteEvent('mailbox-failed', 'x@y: timeout', 'sweep');
    const s = await status.getSystemStatus();
    assert.ok(s.quiet.mailboxTimeouts24h >= 1);
    assert.equal(s.banner.level === 'red' && /TIMEOUT/i.test(s.banner.title), false, 'a timeout never makes the page red');
});

test('status: a stopped job appears in problems and outages', async () => {
    fakeDb();
    jobs.registerJob('sweep', 'Daily sweep', MIN, Date.now() - 10 * MIN);
    const s = await status.getSystemStatus();
    assert.ok(s.outages.some(o => o.key === 'job:sweep'));
    assert.ok(s.problems.some(p => /DAILY SWEEP HAS STOPPED/.test(p)));
    assert.equal(s.banner.level, 'red');
});
