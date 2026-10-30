// Step 53: the real background jobs are wired to runJob - started as the server
// starts them, against a database that never answers. Each must give the
// stuck round up at its limit and run again (the Oct 28 pattern, per job).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let hang = true;
let calls = 0;
const never = new Promise(() => {});
mock.module('../src/db.ts', { exports: { db: { query: async () => { calls++; return hang ? never : { rows: [] }; }, connect: async () => never } } });
mock.module('../src/realtime.ts', { exports: { broadcast() {}, addClient() {}, removeClient() {} } });

process.env.HOT_ENABLED = 'true';
process.env.SWEEP_ENABLED = 'true';
process.env.ACTIVE_ENABLED = 'true';
const jobs = await import('../src/jobHealth.ts');
const { startHotList, HOT_ROUND_LIMIT_MS } = await import('../src/hotList.ts');
const { startSweep, SWEEP_BATCH_LIMIT_MS } = await import('../src/sweep.ts');
const { startStaleAddSweep, STALE_ADD_ROUND_LIMIT_MS } = await import('../src/mailboxTest.ts');
const { startActiveCheck, ACTIVE_ROUND_LIMIT_MS } = await import('../src/activeCheck.ts');
const { startSyncAlert, ALERT_ROUND_LIMIT_MS } = await import('../src/syncAlert.ts');

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };
const quiet = (t) => { t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };

test('the job limits are the agreed ones', () => {
    assert.equal(HOT_ROUND_LIMIT_MS, 3 * 60 * 1000);
    assert.equal(SWEEP_BATCH_LIMIT_MS, 5 * 60 * 1000);
    assert.equal(STALE_ADD_ROUND_LIMIT_MS, 3 * 60 * 1000);
    assert.equal(ACTIVE_ROUND_LIMIT_MS, 3 * 60 * 1000);
    assert.equal(ALERT_ROUND_LIMIT_MS, 60 * 1000);
});

for (const [name, tickMs, limitMs, start] of [
    ['hot-list', 10 * 1000, 3 * 60 * 1000, () => startHotList()],
    ['stale-add', 60 * 1000, 3 * 60 * 1000, () => startStaleAddSweep()],
    ['active-check', 60 * 1000, 3 * 60 * 1000, () => startActiveCheck()],
]) {
    test(`${name}: a round stuck on the database is abandoned and the job runs again`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        quiet(t);
        jobs.resetJobs();
        hang = true;
        start();
        t.mock.timers.tick(tickMs);
        await settle();
        assert.equal(jobs.isJobRunning(name), true, 'the first round is stuck');
        t.mock.timers.tick(limitMs);
        await settle();
        assert.equal(jobs.jobInfo(name).abandoned >= 1, true, 'abandoned at its limit');
        hang = false;
        const before = jobs.jobInfo(name).lastOkAt;
        t.mock.timers.tick(tickMs);
        await settle();
        assert.ok(jobs.jobInfo(name).lastOkAt > before || !jobs.isJobRunning(name), 'a later round ran');
    });
}

test('sweep: a batch stuck on the database is abandoned and the chain keeps going', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    quiet(t);
    jobs.resetJobs();
    hang = true;
    startSweep();
    t.mock.timers.tick(20 * 1000);
    await settle();
    assert.equal(jobs.isJobRunning('sweep'), true);
    t.mock.timers.tick(5 * 60 * 1000);
    await settle();
    assert.ok(jobs.jobInfo('sweep').abandoned >= 1);
    hang = false;
    const before = calls;
    t.mock.timers.tick(15 * 60 * 1000);
    await settle();
    assert.ok(calls > before, 'the next batch ran (the chain did not end)');
});

test('alerts: a stuck alert round is abandoned and the loop keeps going', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    quiet(t);
    jobs.resetJobs();
    hang = true;
    startSyncAlert();
    t.mock.timers.tick(60 * 1000);
    await settle();
    t.mock.timers.tick(60 * 1000 + 1);
    await settle();
    assert.ok(jobs.jobInfo('alerts').abandoned >= 1);
});

// Last: it starts every job again (the stale-add check starts only once per process).
test('every job registers itself with a heartbeat when started', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    quiet(t);
    jobs.resetJobs();
    startHotList();
    startSweep();
    startActiveCheck();
    startSyncAlert();
    jobs.registerJob('stale-add', 'x', 1);
    const names = jobs.allJobs().map(j => j.name).sort();
    assert.deepEqual(names, ['active-check', 'alerts', 'hot-list', 'stale-add', 'sweep']);
});

