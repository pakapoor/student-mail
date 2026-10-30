// Step 53: one alert loop (syncAlert.ts) emails the owner when something
// starts and when it ends: central sync stalled, any job stopped, a crash,
// expired codes above 3. No real mail server or database: fakes only.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let query = async () => ({ rows: [] });
mock.module('../src/db.ts', { exports: { db: { query: (...a) => query(...a) } } });
const transportMails = [];
let sendFails = false;
mock.module('nodemailer', { defaultExport: { createTransport: () => ({ sendMail: async (m) => { if (sendFails) throw new Error('smtp down'); transportMails.push(m); } }) } });

process.env.ACTIVE_CENTRAL_EMAIL = 'central@example.test';
const alerts = await import('../src/syncAlert.ts');
const jobs = await import('../src/jobHealth.ts');
const status = await import('../src/systemStatus.ts');
const crash = await import('../src/crashLog.ts');

const MIN = 60 * 1000;
const quiet = (t) => ({ errors: t.mock.method(console, 'error', () => {}), logs: t.mock.method(console, 'log', () => {}) });
const fakeMailer = () => { const sent = []; return { sent, send: async (from, subject, text) => { sent.push({ from, subject, text }); } }; };
const subjects = (m) => m.sent.map(s => s.subject);

beforeEach(() => {
    alerts.resetAlerts();
    jobs.resetJobs();
    crash.resetCrashLog();
    query = async () => ({ rows: [] });
    transportMails.length = 0;
    sendFails = false;
    delete process.env.ALERT_EMAIL;
});

// --- Jobs ---------------------------------------------------------------------

test('a stopped job emails once when it stops and once when it runs again', async t => {
    quiet(t);
    const m = fakeMailer();
    jobs.registerJob('hot-list', 'Hot list', 5 * MIN, 0);
    await alerts.checkJobs(6 * MIN, m);
    await alerts.checkJobs(7 * MIN, m);
    await alerts.checkJobs(8 * MIN, m);
    assert.deepEqual(subjects(m), ['Student Mail: Hot list has STOPPED']);
    jobs.beat('hot-list', 8 * MIN + 1);
    await alerts.checkJobs(9 * MIN, m);
    assert.deepEqual(subjects(m).slice(1), ['Student Mail: hot-list is running again']);
});

test('a stopped job logs an error line on every check while stopped', async t => {
    const { errors } = quiet(t);
    jobs.registerJob('sweep', 'Daily sweep', 30 * MIN, 0);
    for (let i = 31; i <= 35; i++) await alerts.checkJobs(i * MIN, fakeMailer());
    assert.equal(errors.mock.calls.filter(c => /JOB STOPPED \[sweep\]/.test(String(c.arguments[0]))).length, 5);
});

test('a job within its gap sends nothing and logs nothing', async t => {
    const { errors } = quiet(t);
    const m = fakeMailer();
    jobs.registerJob('sweep', 'Daily sweep', 30 * MIN, 0);
    await alerts.checkJobs(29 * MIN, m);
    assert.equal(m.sent.length, 0);
    assert.equal(errors.mock.calls.length, 0);
});

test('two stopped jobs: one email each, independent recoveries', async t => {
    quiet(t);
    const m = fakeMailer();
    jobs.registerJob('a', 'Job A', MIN, 0);
    jobs.registerJob('b', 'Job B', MIN, 0);
    await alerts.checkJobs(2 * MIN, m);
    assert.equal(m.sent.length, 2);
    jobs.beat('a', 2 * MIN);
    await alerts.checkJobs(2 * MIN + 1, m);
    assert.deepEqual(subjects(m).slice(2), ['Student Mail: a is running again']);
});

test('the stopped-job email names the last error and the time it last worked', async t => {
    quiet(t);
    const m = fakeMailer();
    jobs.registerJob('poll', 'Backup poll', MIN, 0);
    await jobs.runJob('poll', async () => { throw new Error('connect ECONNREFUSED'); }, 1000);
    await alerts.checkJobs(2 * MIN, m);
    assert.match(m.sent[0].text, /ECONNREFUSED/);
    assert.match(m.sent[0].text, /1970-01-01T00:00:00/);
});

test('a job that stops, recovers, and stops again sends a second pair', async t => {
    quiet(t);
    const m = fakeMailer();
    jobs.registerJob('j', 'J', MIN, 0);
    await alerts.checkJobs(2 * MIN, m);
    jobs.beat('j', 2 * MIN);
    await alerts.checkJobs(2 * MIN + 1, m);
    await alerts.checkJobs(4 * MIN, m);
    assert.equal(m.sent.length, 3);
});

// --- Central sync (Step 52 behaviour kept) -------------------------------------

test('central sync stall: one email, then one on recovery (unchanged from Step 52)', async t => {
    quiet(t);
    const m = { sent: [], send: async (from, subject) => { if (from === 'alerts53@example.test') m.sent.push({ subject }); } };
    status.noteSyncSuccess('alerts53@example.test');
    const t0 = Date.now();
    await alerts.checkSyncStall(t0 + 6 * MIN, m);
    await alerts.checkSyncStall(t0 + 7 * MIN, m);
    assert.deepEqual(subjects(m), ['Student Mail: emails are NOT reaching the console']);
    status.noteSyncSuccess('alerts53@example.test');
    await alerts.checkSyncStall(Date.now() + 1000, m);
    assert.equal(m.sent.length, 2);
});

// --- Crash -------------------------------------------------------------------

test('a crash found at startup is emailed once with its cause and downtime', async t => {
    quiet(t);
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'alerts-')), 'run-state.json');
    crash.beginRun(1000, file);
    crash.recordCrash(new Error('terminating connection due to administrator command'), 2000, file);
    crash.resetCrashLog();
    crash.beginRun(7000, file);
    const m = fakeMailer();
    await alerts.checkCrash(m);
    await alerts.checkCrash(m);
    assert.deepEqual(subjects(m), ['Student Mail: the backend CRASHED and restarted']);
    assert.match(m.sent[0].text, /down 5 s/);
    assert.match(m.sent[0].text, /administrator command/);
});

test('no crash: no crash email', async () => {
    const m = fakeMailer();
    crash.beginRun(1000, path.join(mkdtempSync(path.join(os.tmpdir(), 'alerts-')), 'run-state.json'));
    await alerts.checkCrash(m);
    assert.equal(m.sent.length, 0);
});

test('the crash email goes out even if storing the crash in the database fails', async t => {
    quiet(t);
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'alerts-')), 'run-state.json');
    crash.beginRun(1000, file);
    crash.resetCrashLog();
    crash.beginRun(2000, file);
    query = async () => { throw new Error('db down'); };
    const m = fakeMailer();
    await alerts.checkCrash(m);
    assert.equal(m.sent.length, 1);
});

// --- Expired codes -----------------------------------------------------------

const codesList = (n) => async () => Array.from({ length: n }, (_, i) => ({ at: `2026-10-30T10:0${i}:00Z`, details: `Student ${i} (s${i}@x)` }));

test('3 expired codes waiting: no email (alert is above 3)', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkExpiredCodes(0, m, codesList(3));
    assert.equal(m.sent.length, 0);
});

test('4 expired codes waiting: one email listing all four', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkExpiredCodes(0, m, codesList(4));
    await alerts.checkExpiredCodes(MIN, m, codesList(5));
    assert.deepEqual(subjects(m), ['Student Mail: 4 expired codes still waiting']);
    for (let i = 0; i < 4; i++) assert.match(m.sent[0].text, new RegExp(`Student ${i}`));
});

test('back to 3 or fewer: one "back to" email', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkExpiredCodes(0, m, codesList(6));
    await alerts.checkExpiredCodes(MIN, m, codesList(2));
    await alerts.checkExpiredCodes(2 * MIN, m, codesList(1));
    assert.deepEqual(subjects(m), ['Student Mail: 6 expired codes still waiting', 'Student Mail: expired codes back to 2']);
});

test('flapping between 3 and 4 sends at most one email pair per 15 min', async t => {
    quiet(t);
    const m = fakeMailer();
    for (let i = 0; i < 14; i++) await alerts.checkExpiredCodes(i * MIN, m, codesList(i % 2 ? 3 : 4));
    assert.equal(m.sent.length, 2, 'one above + one back within the first 15 min');
    await alerts.checkExpiredCodes(15 * MIN, m, codesList(4));
    assert.equal(m.sent.length, 3, 'a new pair may start once 15 min have passed');
});

test('above 3 for a long time: still only one email', async t => {
    quiet(t);
    const m = fakeMailer();
    for (let i = 0; i < 120; i++) await alerts.checkExpiredCodes(i * MIN, m, codesList(7));
    assert.equal(m.sent.length, 1);
});

test('expired codes start below the threshold: no back-to email ever', async t => {
    quiet(t);
    const m = fakeMailer();
    for (let i = 0; i < 8; i++) await alerts.checkExpiredCodes(i * MIN, m, codesList(i % 4));
    assert.equal(m.sent.length, 0);
});

test('waitingCodes keeps only open codes from the last 24 h', async () => {
    query = async () => ({ rows: [] });
    assert.deepEqual(await alerts.waitingCodes(Date.now()), []);
});

// --- Mailer and loop robustness ------------------------------------------------

test('a failing alert email is logged and never throws', async t => {
    const { errors } = quiet(t);
    jobs.registerJob('j', 'J', MIN, 0);
    await alerts.checkJobs(2 * MIN, { send: async () => { throw new Error('smtp down'); } });
    assert.ok(errors.mock.calls.some(c => /could not send the alert email/.test(String(c.arguments[0]))));
});

test('a failing email does not mean the alert is resent every minute', async t => {
    quiet(t);
    let tries = 0;
    jobs.registerJob('j', 'J', MIN, 0);
    const failing = { send: async () => { tries++; throw new Error('smtp down'); } };
    await alerts.checkJobs(2 * MIN, failing);
    await alerts.checkJobs(3 * MIN, failing);
    assert.equal(tries, 1, 'one attempt per incident; the journal line keeps repeating');
});

test('checkAll: one check failing does not stop the others', async t => {
    quiet(t);
    jobs.registerJob('j', 'J', MIN, 0);
    query = async () => { throw new Error('db down'); };
    const m = fakeMailer();
    await alerts.checkAll(Date.now() + 10 * MIN, m);
    assert.ok(subjects(m).includes('Student Mail: J has STOPPED'));
});

test('the real mailer sends nothing without ALERT_EMAIL', async t => {
    quiet(t);
    jobs.registerJob('j', 'J', MIN, 0);
    await alerts.checkJobs(2 * MIN);
    assert.equal(transportMails.length, 0);
});

test('the real mailer sends from the central mailbox to ALERT_EMAIL', async t => {
    quiet(t);
    process.env.ALERT_EMAIL = 'owner@example.test';
    query = async (sql) => (sql.includes('FROM central_mailboxes') ? { rows: [{ password: 'pw' }] } : { rows: [] });
    jobs.registerJob('j', 'J', MIN, 0);
    await alerts.checkJobs(2 * MIN);
    assert.equal(transportMails.length, 1);
    assert.equal(transportMails[0].to, 'owner@example.test');
    assert.equal(transportMails[0].from, 'central@example.test');
});

test('the real mailer reports a missing central password as a logged error', async t => {
    const { errors } = quiet(t);
    process.env.ALERT_EMAIL = 'owner@example.test';
    query = async () => ({ rows: [] });
    jobs.registerJob('j', 'J', MIN, 0);
    await alerts.checkJobs(2 * MIN);
    assert.equal(transportMails.length, 0);
    assert.ok(errors.mock.calls.some(c => /no password stored/.test(String(c.arguments[1] ?? ''))));
});

test('the real mailer survives an SMTP failure', async t => {
    quiet(t);
    process.env.ALERT_EMAIL = 'owner@example.test';
    sendFails = true;
    query = async (sql) => (sql.includes('FROM central_mailboxes') ? { rows: [{ password: 'pw' }] } : { rows: [] });
    jobs.registerJob('j', 'J', MIN, 0);
    await alerts.checkJobs(2 * MIN);
    assert.equal(transportMails.length, 0);
});

test('a stuck alert round is abandoned and the next round still alerts', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    jobs.registerJob('alerts', 'Alert check', 10 * MIN, 0);
    const stuck = jobs.runJob('alerts', () => new Promise(() => {}), alerts.ALERT_ROUND_LIMIT_MS);
    t.mock.timers.tick(alerts.ALERT_ROUND_LIMIT_MS + 1);
    assert.equal(await stuck, 'abandoned');
    jobs.registerJob('j', 'J', MIN, 0);
    const m = fakeMailer();
    assert.equal(await jobs.runJob('alerts', () => alerts.checkJobs(5 * MIN, m), alerts.ALERT_ROUND_LIMIT_MS), 'ok');
    assert.ok(m.sent.length >= 1);
});

// --- Migadu is third party: timeouts are expected and handled quietly (owner) ---

test('a Migadu timeout on one student mailbox: no email, the banner stays green', async t => {
    quiet(t);
    status.noteProblem('mailbox-failed', 'ann@x', 'ann@x: timeout (mailbox did not respond within 45000ms)', 'sweep');
    const m = fakeMailer();
    await alerts.checkJobs(Date.now(), m);
    await alerts.checkExpiredCodes(Date.now(), m, async () => []);
    assert.equal(m.sent.length, 0);
    assert.equal(status.makeBanner(status.currentOutages(Date.now()).filter(o => !o.key.startsWith('sync:')), { databaseError: null, crashesLastHour: 0, diskFull: null, lastEmailAt: Date.now() }, Date.now()).level, 'green');
});

test('a Migadu network blip on the central sync: no email while syncs still succeed within 5 min', async t => {
    quiet(t);
    const m = { sent: [], send: async (from, subject) => { if (from === 'blip@example.test') m.sent.push(subject); } };
    status.noteSyncSuccess('blip@example.test');
    status.noteProblem('sync-failed', 'blip@example.test', 'Client network socket disconnected before secure TLS connection was established');
    await alerts.checkSyncStall(Date.now() + 2 * MIN, m);
    assert.equal(m.sent.length, 0);
});

test('Migadu failing 10 times in an hour is amber "needs a look", never an email by itself', async t => {
    quiet(t);
    assert.equal(status.needsLook(9, []).length, 0);
    assert.equal(status.needsLook(10, []).length, 1);
    const m = fakeMailer();
    await alerts.checkJobs(Date.now(), m);
    assert.equal(m.sent.length, 0);
});

test('Migadu down long enough that no mail gets through for 5 min: red and one email', async t => {
    quiet(t);
    const m = { sent: [], send: async (from, subject) => { if (from === 'migadu-down@example.test') m.sent.push(subject); } };
    status.noteSyncSuccess('migadu-down@example.test');
    const t0 = Date.now();
    for (let i = 1; i <= 30; i++) await alerts.checkSyncStall(t0 + i * MIN, m);
    assert.deepEqual(m.sent, ['Student Mail: emails are NOT reaching the console']);
    assert.ok(status.currentOutages(t0 + 30 * MIN).some(o => o.key === 'sync:migadu-down@example.test'));
});
