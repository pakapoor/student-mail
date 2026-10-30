// Step 53: no background job may stop silently (jobHealth.ts). The Oct 28 bug
// was a round that never finished and blocked every later one for 41 hours:
// every test here asks "what if this round never ends, or throws?".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerJob, beat, runJob, overdueJobs, jobInfo, allJobs, isJobRunning, resetJobs, JobAbandoned } from '../src/jobHealth.ts';

const defer = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const settle = () => new Promise(setImmediate);
const quiet = (t) => t.mock.method(console, 'error', () => {});

beforeEach(() => resetJobs());

test('a round that completes records a heartbeat and returns ok', async () => {
    registerJob('j', 'Job', 1000, 0);
    assert.equal(await runJob('j', async () => 42, 1000), 'ok');
    assert.ok(jobInfo('j').lastOkAt > 0);
    assert.equal(jobInfo('j').lastError, null);
});

test('a round that throws is caught, logged, and returns failed (never throws)', async t => {
    const errors = quiet(t);
    registerJob('j', 'Job', 1000, 0);
    assert.equal(await runJob('j', async () => { throw new Error('boom'); }, 1000), 'failed');
    assert.equal(jobInfo('j').lastError, 'boom');
    assert.ok(errors.mock.calls.some(c => String(c.arguments[0]).includes('j failed')));
});

test('a synchronous throw inside the work is caught too', async t => {
    quiet(t);
    registerJob('j', 'Job', 1000, 0);
    assert.equal(await runJob('j', () => { throw new Error('sync boom'); }, 1000), 'failed');
    assert.equal(jobInfo('j').lastError, 'sync boom');
});

test('a failed round does not move the heartbeat', async t => {
    quiet(t);
    registerJob('j', 'Job', 1000, 5);
    await runJob('j', async () => { throw new Error('x'); }, 1000);
    assert.equal(jobInfo('j').lastOkAt, 5);
});

test('a round that NEVER settles is abandoned at its limit', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    registerJob('j', 'Job', 1000, 0);
    const run = runJob('j', () => new Promise(() => {}), 5000);
    t.mock.timers.tick(4999);
    await settle();
    assert.equal(isJobRunning('j'), true, 'still within the limit');
    t.mock.timers.tick(2);
    assert.equal(await run, 'abandoned');
    assert.equal(isJobRunning('j'), false, 'the guard is released');
    assert.equal(jobInfo('j').abandoned, 1);
    assert.match(jobInfo('j').lastError, /did not finish within 5 s/);
});

test('after an abandoned round the next round runs (the Oct 28 bug)', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    registerJob('j', 'Job', 1000, 0);
    const first = runJob('j', () => new Promise(() => {}), 100);
    assert.equal(await runJob('j', async () => 1, 100), 'skipped', 'not while the first is within its limit');
    t.mock.timers.tick(101);
    await first;
    let ran = false;
    assert.equal(await runJob('j', async () => { ran = true; }, 100), 'ok');
    assert.equal(ran, true);
});

test('a second round while one is running is skipped, not queued forever', async () => {
    const gate = defer();
    registerJob('j', 'Job', 1000, 0);
    const first = runJob('j', () => gate.promise, 10000);
    assert.equal(await runJob('j', async () => {}, 10000), 'skipped');
    gate.resolve();
    assert.equal(await first, 'ok');
});

test('an abandoned round that finishes late cannot clear the newer round\'s guard', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    registerJob('j', 'Job', 1000, 0);
    const late = defer(), second = defer();
    const first = runJob('j', () => late.promise, 100);
    t.mock.timers.tick(101);
    await first;
    const newer = runJob('j', () => second.promise, 10000);
    late.resolve();
    await settle(); await settle();
    assert.equal(isJobRunning('j'), true, 'the newer round still holds its guard');
    assert.equal(await runJob('j', async () => {}, 100), 'skipped');
    second.resolve();
    assert.equal(await newer, 'ok');
});

test('an abandoned round that fails late raises no unhandled rejection', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    registerJob('j', 'Job', 1000, 0);
    const late = defer();
    const run = runJob('j', () => late.promise, 100);
    t.mock.timers.tick(101);
    await run;
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    late.reject(new Error('late failure'));
    await settle(); await settle();
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, 0);
});

test('the limit timer is cleared when a round finishes (no stray abandon)', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const errors = quiet(t);
    registerJob('j', 'Job', 1000, 0);
    assert.equal(await runJob('j', async () => 1, 100), 'ok');
    t.mock.timers.tick(1000);
    assert.equal(errors.mock.calls.length, 0);
    assert.equal(jobInfo('j').abandoned, 0);
});

test('jobs are independent: one stuck job does not block another', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    registerJob('a', 'A', 1000, 0);
    registerJob('b', 'B', 1000, 0);
    const stuck = runJob('a', () => new Promise(() => {}), 1000);
    assert.equal(await runJob('b', async () => {}, 1000), 'ok');
    t.mock.timers.tick(1001);
    await stuck;
});

test('runJob works for a job that was never registered (no heartbeat, no crash)', async () => {
    assert.equal(await runJob('unknown', async () => {}, 100), 'ok');
    assert.equal(jobInfo('unknown'), undefined);
});

test('a job is overdue once its last completed round is older than its gap', () => {
    registerJob('j', 'Job', 60000, 1000);
    assert.deepEqual(overdueJobs(1000 + 60000).map(j => j.name), [], 'exactly at the gap: not yet');
    const over = overdueJobs(1000 + 60001);
    assert.equal(over.length, 1);
    assert.equal(over[0].overdueForMs, 60001);
});

test('a job that never completes a round turns overdue from its registration', () => {
    registerJob('j', 'Job', 1000, 50);
    assert.equal(overdueJobs(1051).length, 1);
});

test('a heartbeat clears the overdue state', () => {
    registerJob('j', 'Job', 1000, 0);
    assert.equal(overdueJobs(5000).length, 1);
    beat('j', 4900);
    assert.equal(overdueJobs(5000).length, 0);
});

test('a heartbeat also clears the last error', async t => {
    quiet(t);
    registerJob('j', 'Job', 1000, 0);
    await runJob('j', async () => { throw new Error('x'); }, 100);
    beat('j');
    assert.equal(jobInfo('j').lastError, null);
});

test('beat on an unknown job is harmless', () => {
    beat('nope');
    assert.equal(allJobs().length, 0);
});

test('registering again keeps the heartbeat and counters', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    registerJob('j', 'Job', 1000, 0);
    beat('j', 777);
    const run = runJob('j', () => new Promise(() => {}), 10);
    t.mock.timers.tick(11);
    await run;
    registerJob('j', 'Job renamed', 2000, 99999);
    const info = jobInfo('j');
    assert.equal(info.lastOkAt, 777);
    assert.equal(info.abandoned, 1);
    assert.equal(info.label, 'Job renamed');
    assert.equal(info.overdueAfterMs, 2000);
});

test('overdue jobs list each job with its own gap', () => {
    registerJob('fast', 'Fast', 1000, 0);
    registerJob('slow', 'Slow', 100000, 0);
    assert.deepEqual(overdueJobs(5000).map(j => j.name), ['fast']);
});

test('jobInfo and allJobs return copies (callers cannot corrupt the state)', () => {
    registerJob('j', 'Job', 1000, 0);
    jobInfo('j').lastOkAt = 123456;
    allJobs()[0].lastOkAt = 654321;
    assert.equal(jobInfo('j').lastOkAt, 0);
});

test('JobAbandoned is an Error with the job name in the message', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const errors = quiet(t);
    registerJob('hot-list', 'Hot', 1000, 0);
    const run = runJob('hot-list', () => new Promise(() => {}), 2000);
    t.mock.timers.tick(2001);
    await run;
    assert.ok(errors.mock.calls.some(c => /ABANDONED hot-list/.test(String(c.arguments[0]))));
    assert.ok(new JobAbandoned('x') instanceof Error);
});

test('many consecutive stuck rounds never pile up: one at a time, each abandoned', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    registerJob('j', 'Job', 1000, 0);
    let started = 0;
    for (let i = 0; i < 5; i++) {
        const run = runJob('j', () => { started++; return new Promise(() => {}); }, 100);
        assert.equal(await runJob('j', async () => { started++; }, 100), 'skipped');
        t.mock.timers.tick(101);
        assert.equal(await run, 'abandoned');
    }
    assert.equal(started, 5);
    assert.equal(jobInfo('j').abandoned, 5);
});
