// Step 53 (owner: "3 nines"): uptime is measured, and the HTTPS certificate and
// the disk - each able to take the whole site down - alert before they do.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('../src/db.ts', { exports: { db: { query: async () => ({ rows: [] }) } } });
const checks = await import('../src/serverChecks.ts');
const alerts = await import('../src/syncAlert.ts');

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const S = Math.floor(NOW / 1000);
const DAY_S = 24 * 60 * 60;
const log = (entries) => entries.map(([ago, r]) => `${S - ago} ${r}`).join('\n') + '\n';
const quiet = (t) => { t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };
const fakeMailer = () => { const sent = []; return { sent, send: async (_f, subject) => { sent.push(subject); } }; };

beforeEach(() => alerts.resetAlerts());

// --- Uptime ------------------------------------------------------------------------

test('all minutes ok: 100% console up and mail flowing', () => {
    const u = checks.summarizeHealthLog(log(Array.from({ length: 1000 }, (_, i) => [i * 60, 'ok'])), NOW);
    assert.equal(u.measuredMinutes, 1000);
    assert.equal(u.consoleUpPct, 100);
    assert.equal(u.mailFlowingPct, 100);
});

test('43 minutes down in a 30-day month is exactly at the 99.9% line', () => {
    const minutes = 30 * 24 * 60;
    const entries = Array.from({ length: minutes }, (_, i) => [i * 60, i < 43 ? 'down' : 'ok']);
    const u = checks.summarizeHealthLog(log(entries), NOW);
    assert.equal(u.downMinutes, 43);
    assert.ok(u.consoleUpPct >= 99.9 && u.consoleUpPct < 99.91, String(u.consoleUpPct));
});

test('stalled minutes count as console up but not as mail flowing', () => {
    const u = checks.summarizeHealthLog(log([[60, 'ok'], [120, 'stalled'], [180, 'down'], [240, 'ok']]), NOW);
    assert.equal(u.consoleUpPct, 75);
    assert.equal(u.mailFlowingPct, 50);
    assert.equal(u.stalledMinutes, 1);
    assert.equal(u.downMinutes, 1);
});

test('only the last 30 days count', () => {
    const u = checks.summarizeHealthLog(log([[31 * DAY_S, 'down'], [60, 'ok']]), NOW);
    assert.equal(u.measuredMinutes, 1);
    assert.equal(u.consoleUpPct, 100);
});

test('garbage and unknown lines are ignored', () => {
    const u = checks.summarizeHealthLog(`hello\n${S - 60} ok\n${S - 120} weird\nxx ok\n\n${S + 99999} ok\n`, NOW);
    assert.equal(u.measuredMinutes, 1);
});

test('the start of measuring is the oldest counted line', () => {
    const u = checks.summarizeHealthLog(log([[600, 'ok'], [60, 'ok']]), NOW);
    assert.equal(u.since, new Date((S - 600) * 1000).toISOString());
});

test('no log: not measured yet (no fake 100%)', () => {
    const u = checks.readUptime(NOW, path.join(os.tmpdir(), 'no-such-dir', 'health.log'));
    assert.equal(u.measuredMinutes, 0);
    assert.equal(u.consoleUpPct, null);
    assert.equal(u.since, null);
});

test('readUptime reads the real log file', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'uptime-')), 'health.log');
    writeFileSync(file, log([[60, 'ok'], [120, 'down']]));
    assert.equal(checks.readUptime(NOW, file).consoleUpPct, 50);
});

test('the health log lives next to the crash state (RUN_STATE_DIR)', () => {
    assert.equal(checks.healthLogFile({ RUN_STATE_DIR: '/x/y' }), path.resolve('/x/y/health.log'));
});

test('percentages are rounded down, never up (99.99 is not shown as 100)', () => {
    const entries = Array.from({ length: 10000 }, (_, i) => [i * 60, i === 0 ? 'down' : 'ok']);
    assert.equal(checks.summarizeHealthLog(log(entries), NOW).consoleUpPct, 99.99);
});

// --- Certificate ------------------------------------------------------------------

test('certificate with 51 days left: no email', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkCert(NOW, m, async () => 51);
    assert.equal(m.sent.length, 0);
    assert.equal(checks.certState.daysLeft, 51);
});

test('certificate under 14 days: one email, then one when renewed', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkCert(NOW, m, async () => 13.5);
    await alerts.checkCert(NOW + 2 * 3600e3, m, async () => 12.5);
    assert.deepEqual(m.sent, ['Student Mail: HTTPS certificate expires in 13 days']);
    await alerts.checkCert(NOW + 4 * 3600e3, m, async () => 89);
    assert.deepEqual(m.sent.slice(1), ['Student Mail: HTTPS certificate renewed']);
});

test('the certificate is checked at most once an hour', async t => {
    quiet(t);
    let calls = 0;
    const get = async () => { calls++; return 50; };
    await alerts.checkCert(NOW, fakeMailer(), get);
    await alerts.checkCert(NOW + 59 * 60e3, fakeMailer(), get);
    await alerts.checkCert(NOW + 61 * 60e3, fakeMailer(), get);
    assert.equal(calls, 2);
});

test('a failed certificate check (network) never alerts and is shown as an error', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkCert(NOW, m, async () => { throw new Error('ECONNREFUSED'); });
    assert.equal(m.sent.length, 0);
    assert.equal(checks.certState.error, 'ECONNREFUSED');
});

test('certDaysLeft gives up on a server that never answers TLS', async () => {
    const sockets = [];
    const silent = net.createServer((s) => sockets.push(s));
    await new Promise(r => silent.listen(0, '127.0.0.1', r));
    await assert.rejects(checks.certDaysLeft('127.0.0.1', silent.address().port, 300), /no TLS answer/);
    sockets.forEach(s => s.destroy());
    silent.close();
});

test('certDaysLeft fails fast when nothing listens', async () => {
    await assert.rejects(checks.certDaysLeft('127.0.0.1', 1, 2000));
});

test('the certificate host defaults to the console domain, overridable', () => {
    assert.equal(checks.certHost({}), 'app.myemailinfo.com');
    assert.equal(checks.certHost({ CERT_HOST: 'x.test' }), 'x.test');
});

// --- Disk ---------------------------------------------------------------------------

test('disk at 22%: no email', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkDisk(m, () => 0.22);
    assert.equal(m.sent.length, 0);
});

test('disk above 90%: one email, one when back below', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkDisk(m, () => 0.93);
    await alerts.checkDisk(m, () => 0.95);
    assert.deepEqual(m.sent, ['Student Mail: server disk 93% full']);
    await alerts.checkDisk(m, () => 0.6);
    assert.deepEqual(m.sent.slice(1), ['Student Mail: server disk back to 60%']);
});

test('exactly 90% is not yet an alert', async t => {
    quiet(t);
    const m = fakeMailer();
    await alerts.checkDisk(m, () => 0.9);
    assert.equal(m.sent.length, 0);
});

test('the real disk figure is a ratio between 0 and 1', () => {
    const r = checks.diskUsedRatio('/');
    assert.ok(r >= 0 && r <= 1);
});
