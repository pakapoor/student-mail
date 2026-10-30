// Step 53: every crash is detected at the next start, with its cause, and
// stored once (crashLog.ts). The backend crashed 3 times in October (PostgreSQL
// restarts) and nobody saw it.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let queries = [];
let failQuery = false;
mock.module('../src/db.ts', { exports: { db: { query: async (sql, params) => { if (failQuery) throw new Error('db down'); queries.push({ sql, params }); return { rows: [] }; } } } });
const crash = await import('../src/crashLog.ts');

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'crashlog-')), 'run-state.json');
const quiet = (t) => t.mock.method(console, 'error', () => {});

beforeEach(() => { crash.resetCrashLog(); queries = []; failQuery = false; });

test('first ever start: no previous state, no crash', () => {
    assert.equal(crash.beginRun(1000, tmpFile()), null);
});

test('previous run stopped cleanly: no crash', () => {
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.markCleanStop(2000, file);
    crash.resetCrashLog();
    assert.equal(crash.beginRun(3000, file), null);
});

test('previous run ended without a clean stop: crash detected', t => {
    quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.markAlive(5000, file);
    crash.resetCrashLog();
    const found = crash.beginRun(8000, file);
    assert.equal(found.crashedAt, 5000, 'last known alive');
    assert.equal(found.downMs, 3000);
    assert.match(found.cause, /no cause recorded/);
});

test('a recorded crash cause is reported at the next start', t => {
    quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.recordCrash(new Error('terminating connection due to administrator command'), 4000, file);
    crash.resetCrashLog();
    const found = crash.beginRun(9000, file);
    assert.equal(found.crashedAt, 4000);
    assert.equal(found.downMs, 5000);
    assert.match(found.cause, /Error: terminating connection due to administrator command/);
});

test('a non-Error crash value is recorded as text', t => {
    quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.recordCrash('plain string rejection', 2000, file);
    crash.resetCrashLog();
    assert.match(crash.beginRun(3000, file).cause, /plain string rejection/);
});

test('a very long cause is cut to 1000 characters', t => {
    quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.recordCrash(new Error('x'.repeat(5000)), 2000, file);
    assert.ok(crash.readState(file).crash.message.length <= 1000);
});

test('a crash before beginRun (startup crash) is still recorded', t => {
    quiet(t);
    const file = tmpFile();
    crash.recordCrash(new Error('startup boom'), 500, file);
    crash.resetCrashLog();
    const found = crash.beginRun(1500, file);
    assert.match(found.cause, /startup boom/);
    assert.equal(found.crashedAt, 500);
});

test('a damaged state file is treated as no previous run (no crash, no throw)', () => {
    const file = tmpFile();
    writeFileSync(file, '{ not json');
    assert.equal(crash.beginRun(1000, file), null);
    assert.equal(crash.readState(file).startedAt, 1000, 'a fresh state replaced it');
});

test('a state file without startedAt is ignored', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ hello: 1 }));
    assert.equal(crash.readState(file), null);
});

test('the state directory is created when missing', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'crashlog-')), 'deep', 'er', 'run-state.json');
    crash.beginRun(1000, file);
    assert.ok(existsSync(file));
});

test('writes leave no temporary files behind', () => {
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.markAlive(2000, file);
    crash.markCleanStop(3000, file);
    assert.deepEqual(readdirSync(path.dirname(file)), ['run-state.json']);
});

test('markAlive before beginRun does nothing (no file)', () => {
    const file = tmpFile();
    crash.markAlive(1000, file);
    assert.equal(existsSync(file), false);
});

test('an unwritable state location is logged, never thrown', t => {
    const errors = quiet(t);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crashlog-'));
    const blocker = path.join(dir, 'file');
    writeFileSync(blocker, 'x');
    crash.writeState({ pid: 1, startedAt: 1, aliveAt: 1 }, path.join(blocker, 'run-state.json'));
    assert.ok(errors.mock.calls.length > 0);
});

test('detectCrash is pure: clean stop wins over a recorded crash field', () => {
    assert.equal(crash.detectCrash({ pid: 1, startedAt: 1, aliveAt: 2, cleanStopAt: 3, crash: { at: 2, message: 'x' } }, 10), null);
});

test('detectCrash never reports negative downtime (clock moved back)', () => {
    assert.equal(crash.detectCrash({ pid: 1, startedAt: 1, aliveAt: 100 }, 50).downMs, 0);
});

test('a detected crash is stored once in status_problems, solved, with downtime and cause', async t => {
    quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.recordCrash(new Error('boom'), 2000, file);
    crash.resetCrashLog();
    crash.beginRun(7000, file);
    assert.equal(await crash.storePendingCrash(), true);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /'backend-crash'/);
    assert.match(queries[0].params[2], /Down 5 s · Error: boom/);
    assert.ok(queries[0].params[3] instanceof Date, 'stored as solved: it is a past event');
    assert.equal(await crash.storePendingCrash(), true);
    assert.equal(queries.length, 1, 'not stored twice');
});

test('if the database is down, storing the crash is retried later', async t => {
    quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.resetCrashLog();
    crash.beginRun(2000, file);
    failQuery = true;
    assert.equal(await crash.storePendingCrash(), false);
    failQuery = false;
    assert.equal(await crash.storePendingCrash(), true);
    assert.equal(queries.length, 1);
});

test('the crash is handed to the alert email exactly once', t => {
    quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.resetCrashLog();
    crash.beginRun(2000, file);
    assert.ok(crash.takeCrashToEmail());
    assert.equal(crash.takeCrashToEmail(), null);
});

test('no crash: nothing to store, nothing to email', async () => {
    crash.beginRun(1000, tmpFile());
    assert.equal(await crash.storePendingCrash(), true);
    assert.equal(queries.length, 0);
    assert.equal(crash.takeCrashToEmail(), null);
});

test('the crash is logged loudly at startup', t => {
    const errors = quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.resetCrashLog();
    crash.beginRun(2000, file);
    assert.ok(errors.mock.calls.some(c => /previous run CRASHED/.test(String(c.arguments[0]))));
});

test('stateFile honours RUN_STATE_DIR', () => {
    assert.equal(crash.stateFile({ RUN_STATE_DIR: '/tmp/xyz' }), path.resolve('/tmp/xyz/run-state.json'));
    assert.match(crash.stateFile({}), /\.run[\\/]run-state\.json$/);
});

test('clean stop, then crash in the next run: only the second run is a crash', t => {
    quiet(t);
    const file = tmpFile();
    crash.beginRun(1000, file);
    crash.markCleanStop(1500, file);
    crash.resetCrashLog();
    assert.equal(crash.beginRun(2000, file), null);
    crash.recordCrash(new Error('second'), 2500, file);
    crash.resetCrashLog();
    assert.match(crash.beginRun(3000, file).cause, /second/);
});

test('a real process that dies from an uncaught exception records its cause', async () => {
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crashlog-proc-'));
    const script = path.join(dir, 'die.mjs');
    const modulePath = path.resolve('src/crashLog.ts');
    writeFileSync(script, `
        const c = await import(${JSON.stringify(modulePath)});
        c.installCrashHandlers();
        c.beginRun();
        setTimeout(() => { throw new Error('child exploded'); }, 10);
    `);
    const r = spawnSync(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, RUN_STATE_DIR: dir, DB_HOST: '127.0.0.1', DB_PORT: '1' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, 'the process still exits (systemd restarts it)');
    const state = JSON.parse(readFileSync(path.join(dir, 'run-state.json'), 'utf8'));
    assert.match(state.crash.message, /child exploded/);
    assert.equal(state.cleanStopAt, undefined);
});

test('a real process stopped with SIGTERM records a clean stop and exits 0', async () => {
    const { spawn } = await import('node:child_process');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crashlog-proc-'));
    const script = path.join(dir, 'stop.mjs');
    const modulePath = path.resolve('src/crashLog.ts');
    writeFileSync(script, `
        const c = await import(${JSON.stringify(modulePath)});
        c.installCrashHandlers();
        c.beginRun();
        console.log('ready');
        setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, RUN_STATE_DIR: dir, DB_HOST: '127.0.0.1', DB_PORT: '1' } });
    await new Promise((resolve) => child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); }));
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    const state = JSON.parse(readFileSync(path.join(dir, 'run-state.json'), 'utf8'));
    assert.equal(typeof state.cleanStopAt, 'number');
});

test('a real process with an unhandled promise rejection records it as the cause', async () => {
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crashlog-proc-'));
    const script = path.join(dir, 'reject.mjs');
    const modulePath = path.resolve('src/crashLog.ts');
    writeFileSync(script, `
        const c = await import(${JSON.stringify(modulePath)});
        c.installCrashHandlers();
        c.beginRun();
        Promise.reject(new Error('nobody caught me'));
        setInterval(() => {}, 1000);
    `);
    const r = spawnSync(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, RUN_STATE_DIR: dir, DB_HOST: '127.0.0.1', DB_PORT: '1' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1);
    assert.match(JSON.parse(readFileSync(path.join(dir, 'run-state.json'), 'utf8')).crash.message, /nobody caught me/);
});
