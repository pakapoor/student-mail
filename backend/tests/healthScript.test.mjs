// Step 53 (owner: "3 nines"): the server's self-restart check
// (deploy/systemd/student-mail-health.sh), run for real with fake `curl` and
// `systemctl` on the PATH. A hung backend (no answer) is restarted after 2 min;
// a backend that answers but whose mail is stalled after 10; a healthy one never.
// Every check is logged for the uptime figure. Also: the unit files and the
// atomic frontend build (deploy/build-frontend.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('../deploy/systemd/student-mail-health.sh');

// mode: "ok" (HTTP 200), "stalled" (HTTP 503), "down" (no answer: curl prints 000).
function setup(mode, { hang = 2, stall = 10 } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'health-'));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const modeFile = path.join(dir, 'mode');
    writeFileSync(modeFile, mode);
    writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nm=$(cat ${modeFile})\n[ "$m" = ok ] && { printf 200; exit 0; }\n[ "$m" = stalled ] && { printf 503; exit 0; }\nprintf 000\nexit 28\n`);
    writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${path.join(dir, 'systemctl.log')}\n`);
    chmodSync(path.join(bin, 'curl'), 0o755);
    chmodSync(path.join(bin, 'systemctl'), 0o755);
    const runDir = path.join(dir, 'run');
    mkdirSync(runDir);
    const state = path.join(dir, 'state');
    const log = path.join(runDir, 'health.log');
    return {
        dir, log, state,
        run: () => spawnSync('sh', [SCRIPT], {
            env: { PATH: `${bin}:/usr/bin:/bin`, HEALTH_STATE_DIR: state, HEALTH_LOG: log, HEALTH_HANG_LIMIT: String(hang), HEALTH_STALL_LIMIT: String(stall) },
            encoding: 'utf8',
        }),
        setMode: (m) => writeFileSync(modeFile, m),
        counter: (name) => Number(readFileSync(path.join(state, name), 'utf8').trim()),
        writeCounter: (name, v) => { mkdirSync(state, { recursive: true }); writeFileSync(path.join(state, name), v); },
        restarts: () => (existsSync(path.join(dir, 'systemctl.log')) ? readFileSync(path.join(dir, 'systemctl.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
        logLines: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    };
}
const runs = (h, n) => { for (let i = 0; i < n; i++) assert.equal(h.run().status, 0); };

test('healthy: nothing is ever restarted, counters stay at 0', () => {
    const h = setup('ok');
    runs(h, 30);
    assert.deepEqual(h.restarts(), []);
    assert.equal(h.counter('stalled'), 0);
    assert.equal(h.counter('down'), 0);
});

test('backend not answering: restarted after 2 checks (2 min), not after 1', () => {
    const h = setup('down');
    h.run();
    assert.deepEqual(h.restarts(), []);
    h.run();
    assert.deepEqual(h.restarts(), ['restart student-mail.service']);
});

test('mail stalled but the backend answers: no restart before 10 checks', () => {
    const h = setup('stalled');
    runs(h, 9);
    assert.deepEqual(h.restarts(), []);
    assert.equal(h.counter('stalled'), 9);
});

test('mail stalled for 10 checks: exactly one restart, counters start again', () => {
    const h = setup('stalled');
    runs(h, 10);
    assert.deepEqual(h.restarts(), ['restart student-mail.service']);
    assert.equal(h.counter('stalled'), 0);
});

test('stalled for 25 checks: a restart every 10, never every minute', () => {
    const h = setup('stalled');
    runs(h, 25);
    assert.equal(h.restarts().length, 2);
});

test('not answering for 10 checks: a restart every 2', () => {
    const h = setup('down');
    runs(h, 10);
    assert.equal(h.restarts().length, 5);
});

test('one healthy answer resets both counters (brief blips never restart)', () => {
    const h = setup('stalled');
    runs(h, 9);
    h.setMode('ok'); h.run();
    h.setMode('stalled'); runs(h, 8);
    h.setMode('down'); h.run();
    h.setMode('ok'); h.run();
    h.setMode('down'); h.run();
    assert.deepEqual(h.restarts(), []);
});

test('a stalled answer between two missing answers resets the not-answering count', () => {
    const h = setup('down');
    h.run();
    h.setMode('stalled'); h.run();
    h.setMode('down'); h.run();
    assert.deepEqual(h.restarts(), []);
});

test('missing answers also count toward the stalled limit', () => {
    const h = setup('stalled', { hang: 100, stall: 3 });
    h.run(); h.setMode('down'); h.run(); h.run();
    assert.equal(h.restarts().length, 1);
});

test('every check is logged with its time and result', () => {
    const h = setup('ok');
    h.run(); h.setMode('stalled'); h.run(); h.setMode('down'); h.run();
    const lines = h.logLines();
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map(l => l.split(' ')[1]), ['ok', 'stalled', 'down']);
    for (const l of lines) assert.ok(Math.abs(Number(l.split(' ')[0]) - Date.now() / 1000) < 60);
});

test('the log is trimmed so it cannot grow forever', () => {
    const h = setup('ok');
    writeFileSync(h.log, Array.from({ length: 50001 }, (_, i) => `${i} ok`).join('\n') + '\n');
    h.run();
    const n = h.logLines().length;
    assert.ok(n <= 45001 && n >= 44999, `trimmed to about 45000 lines (got ${n})`);
    assert.match(h.logLines().at(-1), / ok$/);
});

test('no log folder (dev machine): the check still works', () => {
    const h = setup('down');
    const r = spawnSync('sh', [SCRIPT], { env: { PATH: `${path.join(h.dir, 'bin')}:/usr/bin:/bin`, HEALTH_STATE_DIR: h.state, HEALTH_LOG: '/nonexistent/dir/health.log' }, encoding: 'utf8' });
    assert.equal(r.status, 0);
});

for (const garbage of ['', 'abc', '1x', '-5', '\n\n']) {
    test(`a damaged counter (${JSON.stringify(garbage)}) is treated as 0`, () => {
        const h = setup('stalled');
        h.writeCounter('stalled', garbage);
        assert.equal(h.run().status, 0);
        assert.equal(h.counter('stalled'), 1);
    });
}

test('the script is valid POSIX sh, and so is the frontend build script', () => {
    assert.equal(spawnSync('sh', ['-n', SCRIPT]).status, 0);
    assert.equal(spawnSync('sh', ['-n', path.resolve('../deploy/build-frontend.sh')]).status, 0);
});

test('the backend unit restarts after any exit, 5 s later, and starts at boot', () => {
    const unit = readFileSync(path.resolve('../deploy/systemd/student-mail.service'), 'utf8');
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^RestartSec=5$/m);
    assert.match(unit, /^WantedBy=multi-user\.target$/m);
    assert.match(unit, /^WorkingDirectory=\/home\/ubuntu\/student-mail\/backend$/m);
});

test('the health timer runs every minute and starts at boot', () => {
    const timer = readFileSync(path.resolve('../deploy/systemd/student-mail-health.timer'), 'utf8');
    assert.match(timer, /^OnUnitActiveSec=1min$/m);
    assert.match(timer, /^WantedBy=timers\.target$/m);
    assert.match(readFileSync(path.resolve('../deploy/systemd/student-mail-health.service'), 'utf8'), /student-mail-health\.sh$/m);
});

test('nginx and PostgreSQL restart after any exit (Ubuntu default was Restart=no)', () => {
    for (const unit of ['nginx.service.d', 'postgresql@.service.d']) {
        const conf = readFileSync(path.resolve(`../deploy/systemd/overrides/${unit}/restart.conf`), 'utf8');
        assert.match(conf, /^\[Service\]$/m);
        assert.match(conf, /^Restart=always$/m);
    }
});

// --- Atomic frontend build ------------------------------------------------------

function fakeFrontend() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fe-'));
    mkdirSync(path.join(root, 'deploy'));
    writeFileSync(path.join(root, 'deploy', 'build-frontend.sh'), readFileSync(path.resolve('../deploy/build-frontend.sh')));
    mkdirSync(path.join(root, 'frontend', 'dist', 'assets'), { recursive: true });
    writeFileSync(path.join(root, 'frontend', 'dist', 'index.html'), 'old');
    writeFileSync(path.join(root, 'frontend', 'dist', 'assets', 'index-OLD.js'), 'old');
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    return { root, bin };
}

test('frontend build: the new build goes live and old assets stay for open tabs', () => {
    const { root, bin } = fakeFrontend();
    writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nmkdir -p dist-new/assets\necho new > dist-new/index.html\necho new > dist-new/assets/index-NEW.js\n');
    chmodSync(path.join(bin, 'npm'), 0o755);
    const r = spawnSync('sh', [path.join(root, 'deploy', 'build-frontend.sh')], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(root, 'frontend', 'dist', 'index.html'), 'utf8').trim(), 'new');
    assert.deepEqual(readdirSync(path.join(root, 'frontend', 'dist', 'assets')).sort(), ['index-NEW.js', 'index-OLD.js']);
    assert.equal(existsSync(path.join(root, 'frontend', 'dist-new')), false);
    assert.equal(existsSync(path.join(root, 'frontend', 'dist-old')), false);
});

test('frontend build: a failed build leaves the live site untouched', () => {
    const { root, bin } = fakeFrontend();
    writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 1\n');
    chmodSync(path.join(bin, 'npm'), 0o755);
    const r = spawnSync('sh', [path.join(root, 'deploy', 'build-frontend.sh')], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(path.join(root, 'frontend', 'dist', 'index.html'), 'utf8'), 'old');
});

test('frontend build: assets older than 14 days are dropped', () => {
    const { root, bin } = fakeFrontend();
    const old = path.join(root, 'frontend', 'dist', 'assets', 'index-OLD.js');
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nmkdir -p dist-new/assets\necho new > dist-new/index.html\necho new > dist-new/assets/index-NEW.js\n');
    chmodSync(path.join(bin, 'npm'), 0o755);
    spawnSync('sh', [path.join(root, 'deploy', 'build-frontend.sh')], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    assert.deepEqual(readdirSync(path.join(root, 'frontend', 'dist', 'assets')), ['index-NEW.js']);
});
