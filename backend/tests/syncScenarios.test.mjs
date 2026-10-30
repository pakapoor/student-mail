// Step 53: central sync scenarios around the Oct 28 outage - the IMAP server
// hanging at different points, a backlog after downtime, catching up after a
// restart, and the 5 s backup poll. Fake IMAP and database only.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

let query = async () => ({ rows: [] });
let connect = async () => { throw new Error('Unexpected connection'); };
mock.module('../src/db.ts', { exports: { db: { query: (...a) => query(...a), connect: () => connect() } } });
let setupImap = () => {};
const clients = [];
class FakeImap extends EventEmitter {
    mailbox = { uidValidity: 1n, exists: 1 };
    closed = false;
    usable = true;
    connect = async () => {};
    getMailboxLock = async () => ({ release() {} });
    mailboxOpen = async () => {};
    fetch = async function* () {};
    search = async () => [];
    logout = async () => {};
    close() { this.closed = true; this.emit('close'); }
    constructor() { super(); clients.push(this); setupImap(this); }
}
mock.module('imapflow', { exports: { ImapFlow: FakeImap } });
const broadcasts = [];
mock.module('../src/realtime.ts', { exports: { broadcast: (...a) => broadcasts.push(a), addClient() {}, removeClient() {} } });

const { syncInbox } = await import('../src/sync.ts');
const { triggerSync, pollAllMailboxes } = await import('../src/mailboxSync.ts');
const { runJob, registerJob, jobInfo, resetJobs } = await import('../src/jobHealth.ts');

const settle = () => new Promise(setImmediate);
const raw = n => Buffer.from(`Message-ID: <m${n}@example.test>\r\nFrom: sender@example.test\r\nTo: student@example.test\r\nSubject: Test ${n}\r\nDate: Sat, 26 Sep 2026 10:00:00 +0000\r\n\r\nBody ${n}\r\n`);
const quiet = (t) => { t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };

// A central mailbox at `from` watermark holding the given UIDs for one student.
function mailbox(uids, { watermark = 10, uidValidity = '1', hangAfter = null } = {}) {
    const inserted = [], watermarks = [];
    // Like a real server: only UIDs from the start of the requested range ("11:*").
    const from = (range) => Number(String(typeof range === 'object' ? (range.uid ?? range.seq) : range).split(':')[0]) || 1;
    setupImap = client => {
        client.mailbox.exists = uids.length;
        client.search = async (range) => uids.filter(u => u >= from(range));
        client.fetch = async function* (range) {
            for (const uid of uids.filter(u => u >= from(range))) {
                if (hangAfter !== null && uid > hangAfter) await new Promise(() => {});
                yield { uid, internalDate: new Date(), source: raw(uid) };
            }
        };
    };
    query = async (sql, params) => {
        if (sql.includes('SELECT email')) return { rows: [{ email: 'student@example.test' }] };
        if (sql.includes('SELECT last_uid')) return { rows: [{ last_uid: String(watermark), uid_validity: uidValidity }] };
        if (sql.includes('UPDATE central_mailboxes')) watermarks.push(params[1]);
        if (sql.includes('college_id')) return { rows: [{ college_id: 7 }] };
        return { rows: [] };
    };
    connect = async () => ({
        async query(sql, params) {
            if (sql.includes('INSERT INTO messages')) { inserted.push(params[0]); return { rowCount: 1, rows: [] }; }
            return { rows: [], rowCount: 0 };
        },
        release() {},
    });
    return { inserted, watermarks };
}

test('a backlog of 60 emails after downtime is fetched completely in one pass', async t => {
    quiet(t);
    const uids = Array.from({ length: 60 }, (_, i) => 11 + i);
    const { inserted, watermarks } = mailbox(uids);
    const r = await syncInbox('staff@example.test', 'fake');
    assert.equal(r.inserted, 60);
    assert.equal(inserted.length, 60);
    assert.equal(watermarks.at(-1), 70, 'the watermark moves to the newest UID');
});

test('a backlog of 300 emails (a weekend down) is fetched completely too', async t => {
    quiet(t);
    const uids = Array.from({ length: 300 }, (_, i) => 11 + i);
    const { inserted } = mailbox(uids);
    await syncInbox('staff@example.test', 'fake');
    assert.equal(inserted.length, 300);
});

test('after a restart the sync starts from the stored watermark, not from scratch', async t => {
    quiet(t);
    const { inserted } = mailbox([5, 6, 11, 12], { watermark: 10 });
    await syncInbox('staff@example.test', 'fake');
    assert.deepEqual(inserted.map(id => id.match(/m(\d+)@/)[1]), ['11', '12']);
});

test('nothing new: no insert, the pass completes quickly', async t => {
    quiet(t);
    const { inserted } = mailbox([]);
    const r = await syncInbox('staff@example.test', 'fake');
    assert.equal(r.inserted, 0);
    assert.equal(inserted.length, 0);
});

test('IMAP connect that never answers: the pass is abandoned and the next pass runs', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    let n = 0;
    setupImap = client => { if (++n === 1) client.connect = () => new Promise(() => {}); else client.mailbox.exists = 0; };
    query = async () => ({ rows: [] });
    const before = clients.length;
    const first = triggerSync('hang-connect@example.test', 'fake');
    await triggerSync('hang-connect@example.test', 'fake');
    t.mock.timers.tick(105001);
    await first;
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(clients.length, before + 2);
    setupImap = () => {};
});

test('the mailbox lock never granted: abandoned, next pass runs', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    let n = 0;
    setupImap = client => { if (++n === 1) client.getMailboxLock = () => new Promise(() => {}); else client.mailbox.exists = 0; };
    query = async () => ({ rows: [] });
    const before = clients.length;
    const first = triggerSync('hang-lock@example.test', 'fake');
    await triggerSync('hang-lock@example.test', 'fake');
    t.mock.timers.tick(105001);
    await first;
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(clients.length, before + 2);
    setupImap = () => {};
});

test('a fetch that hangs mid-stream: emails before the hang are kept; the next pass continues', async t => {
    quiet(t);
    const { inserted } = mailbox([11, 12, 13], { hangAfter: 11 });
    const controller = new AbortController();
    const run = syncInbox('staff@example.test', 'fake', controller.signal).catch(e => e);
    for (let i = 0; i < 200 && inserted.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    controller.abort(new Error('deadline'));
    const failure = await Promise.race([run, new Promise(r => setTimeout(() => r('still hanging'), 2000))]);
    if (failure !== 'still hanging') assert.equal(failure.partial?.inserted ?? 1, 1);
    assert.deepEqual(inserted.map(id => id.match(/m(\d+)@/)[1]), ['11'], 'the first email was stored before the hang');
    const next = mailbox([12, 13], { watermark: 11 });
    await triggerSync('hang-fetch@example.test', 'fake');
    for (let i = 0; i < 10; i++) await settle();
    assert.deepEqual(next.inserted.map(id => id.match(/m(\d+)@/)[1]), ['12', '13']);
    setupImap = () => {};
});

test('a database read that never answers inside a pass: abandoned, not stuck forever', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    let first = true;
    setupImap = client => { client.mailbox.exists = 0; };
    query = async (sql) => { if (first && sql.includes('SELECT email')) { first = false; return new Promise(() => {}); } return { rows: [] }; };
    const before = clients.length;
    const run = triggerSync('hang-db@example.test', 'fake');
    await triggerSync('hang-db@example.test', 'fake');
    t.mock.timers.tick(105001);
    await run;
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(clients.length, before + 2, 'the queued pass ran');
    setupImap = () => {};
});

test('a mailbox recreated (UID validity changed): the sync starts over safely', async t => {
    quiet(t);
    const { inserted } = mailbox([1, 2], { watermark: 500, uidValidity: '999' });
    await syncInbox('staff@example.test', 'fake');
    assert.equal(inserted.length, 2, 'old watermark ignored under a new UID validity');
});

// --- The 5 s backup poll --------------------------------------------------------

test('the backup poll triggers a sync for every central mailbox', async t => {
    quiet(t);
    setupImap = client => { client.mailbox.exists = 0; };
    query = async () => ({ rows: [] });
    const before = clients.length;
    const n = await pollAllMailboxes(async () => [{ email: 'p1@example.test', password: 'x' }, { email: 'p2@example.test', password: 'y' }]);
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(n, 2);
    assert.ok(clients.length >= before + 2);
    setupImap = () => {};
});

test('the backup poll with the database down fails its round, it does not crash', async t => {
    quiet(t);
    resetJobs();
    registerJob('poll', 'Backup poll', 5 * 60 * 1000, 0);
    const r = await runJob('poll', () => pollAllMailboxes(async () => { throw new Error('connect ECONNREFUSED'); }), 30000);
    assert.equal(r, 'failed');
    assert.match(jobInfo('poll').lastError, /ECONNREFUSED/);
});

test('the backup poll keeps running after a failed round', async t => {
    quiet(t);
    resetJobs();
    registerJob('poll', 'Backup poll', 5 * 60 * 1000, 0);
    await runJob('poll', () => pollAllMailboxes(async () => { throw new Error('down'); }), 30000);
    assert.equal(await runJob('poll', () => pollAllMailboxes(async () => []), 30000), 'ok');
    assert.ok(jobInfo('poll').lastOkAt > 0);
});

test('a backup poll round that never finishes is abandoned; the next round runs', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    quiet(t);
    resetJobs();
    registerJob('poll', 'Backup poll', 5 * 60 * 1000, 0);
    const stuck = runJob('poll', () => pollAllMailboxes(() => new Promise(() => {})), 30000);
    t.mock.timers.tick(30001);
    assert.equal(await stuck, 'abandoned');
    assert.equal(await runJob('poll', () => pollAllMailboxes(async () => []), 30000), 'ok');
});
