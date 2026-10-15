// Step 48: the TEST email that confirms a newly added mailbox (src/mailboxTest.ts)
// and the Add students log (src/addLog.ts), against a real, throwaway PostgreSQL and
// a fake mail transport: the add checks the mailbox and sends the mail; a student is
// hidden until it arrives; 60 s without it fails the add (real Application No freed,
// record hidden for good, detailed log entry); a late mail changes nothing then; the
// central sync and the once-a-minute server check cover a closed dialog.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, builders } from './helpers/testdb.mjs';

const t = await startTestDb();
const skip = t ? false : 'no PostgreSQL server binaries available';
after(() => t?.stop());

let mt, addLog, sync, students, admin, thread, b;
if (t) {
    mock.module('../src/db.ts', { exports: { db: t.pool } });
    mt = await import('../src/mailboxTest.ts');
    addLog = await import('../src/addLog.ts');
    sync = await import('../src/sync.ts');
    students = await import('../src/students.ts');
    admin = await import('../src/studentsAdmin.ts');
    thread = await import('../src/thread.ts');
    b = builders(t.pool);
}

const CENTRAL = 'central@example.test';
const WHO = { central: CENTRAL, college: 'KSMA CENTRAL', ip: '1.2.3.4' };

beforeEach(async () => {
    if (t) {
        await t.reset();
        await t.pool.query("INSERT INTO central_mailboxes (email, password) VALUES ($1, 'central-pw')", [CENTRAL]);
    }
});

// Fake transport. `inbox`: Message-IDs already in the student's mailbox; `deliver`:
// a sent mail lands in the inbox (default true); `loginFails`: logins refused first;
// `failSend`: the send throws; `failLook`: looking throws.
function fakeTransport({ deliver = true, loginFails = 0, failSend = false, failLook = false } = {}) {
    const inbox = new Set();
    const calls = { logins: 0, sends: [], looks: [] };
    return {
        calls, inbox,
        async login() { calls.logins++; if (calls.logins <= loginFails) throw new Error('Authentication failed'); },
        async send(from, to, messageId) {
            if (failSend) throw new Error('smtp refused');
            calls.sends.push({ from, to, messageId });
            if (deliver) inbox.add(messageId);
        },
        async waitFor(mailbox, messageId, waitMs) {
            calls.looks.push({ mailbox, messageId, waitMs });
            if (failLook) throw new Error('Authentication failed');
            return inbox.has(messageId) ? { found: true, seconds: 2 } : { found: false, seconds: null };
        },
    };
}
const fakeMigadu = { domain: 'example.test', exists: async () => true };

const quiet = async (fn) => {
    const log = console.log, error = console.error;
    console.log = () => {}; console.error = () => {};
    try { return await fn(); } finally { console.log = log; console.error = error; }
};
// A student as Add students saves one: not confirmed yet.
async function newStudent(fields = {}) {
    const email = await b.student({ first: 'Jane', last: 'Doe', admission: '32237', ...fields });
    const row = (await t.pool.query('UPDATE students SET mailbox_confirmed_at = NULL WHERE email = $1 RETURNING id', [email])).rows[0];
    return { id: row.id, email, password: 'pw123456', name: 'Jane Doe', admissionId: fields.admission ?? '32237' };
}
const age = (email, seconds) => t.pool.query("UPDATE students SET created_at = now() - make_interval(secs => $2) WHERE email = $1", [email, seconds]);
const row = async (email) => (await t.pool.query('SELECT admission_id, deleted_at, mailbox_confirmed_at FROM students WHERE email = $1', [email])).rows[0];
const events = async () => (await t.pool.query('SELECT event, details FROM student_add_log ORDER BY id')).rows;
const look = (email, transport, college = '1') => quiet(() => mt.testNewMailbox(email, WHO, college, transport, 50));

test('the add checks the new mailbox (lookup + login) and sends the TEST email from the central mailbox', { skip }, async () => {
    const s = await newStudent();
    const transport = fakeTransport({ loginFails: 1 });
    assert.equal(await quiet(() => mt.sendFirstTestMail(s, WHO, fakeMigadu, transport)), true);
    assert.equal(transport.calls.logins, 2, 'a refused login is tried again');
    assert.deepEqual(transport.calls.sends.map((x) => [x.from, x.to, x.messageId]), [[{ email: CENTRAL, password: 'central-pw' }, s.email, `<mailbox-test-${s.id}@example.test>`]]);
    const [sent] = await events();
    assert.equal(sent.event, 'test-sent');
    assert.equal(sent.details.lookupFound, true);
    assert.equal(sent.details.loginTries, 2);
    assert.ok(['lookupMs', 'loginMs', 'sendMs'].every((k) => typeof sent.details[k] === 'number'));
    assert.ok(!JSON.stringify(await events()).includes('pw123456') && !JSON.stringify(await events()).includes('central-pw'), 'no password in the log');
});

test('a send that fails is logged, never throws, and is sent again by the next look', { skip }, async () => {
    const s = await newStudent();
    assert.equal(await quiet(() => mt.sendFirstTestMail(s, WHO, fakeMigadu, fakeTransport({ failSend: true }))), false);
    assert.deepEqual((await events()).map((e) => [e.event, e.details.reason]), [['test-send-failed', 'smtp refused']]);
    const transport = fakeTransport();
    assert.deepEqual(await look(s.email, transport), { state: 'received', seconds: 2 });
    assert.equal(transport.calls.sends.length, 1);
});

test('hidden from every staff list until the TEST email arrives, then shown', { skip }, async () => {
    const s = await newStudent();
    const visible = async () => [
        (await admin.searchAdminStudents({ centralEmail: CENTRAL, search: 'Jane' })).students.length,
        (await admin.searchAdminStudents({ centralEmail: CENTRAL })).counts.all,
        (await students.fetchStudents(CENTRAL, '1')).length,
        (await thread.findSearchMatches('Jane Doe', '1', 5)).students.length,
    ];
    assert.deepEqual(await visible(), [0, 0, 0, 0]);
    const transport = fakeTransport();
    await quiet(() => mt.sendFirstTestMail(s, WHO, fakeMigadu, transport));
    assert.deepEqual(await look(s.email, transport), { state: 'received', seconds: 2 });
    assert.deepEqual(await visible(), [1, 1, 1, 1]);
    assert.ok((await row(s.email)).mailbox_confirmed_at);
    assert.deepEqual((await events()).map((e) => [e.event, e.details.via]), [['test-sent', undefined], ['test-received', 'add dialog']]);
});

test('while the mail has not arrived and 60 s have not passed, the answer is waiting', { skip }, async () => {
    const s = await newStudent();
    const transport = fakeTransport({ deliver: false });
    await quiet(() => mt.sendFirstTestMail(s, WHO, fakeMigadu, transport));
    assert.deepEqual(await look(s.email, transport), { state: 'waiting' });
    assert.deepEqual(await look(s.email, fakeTransport({ failLook: true })), { state: 'waiting' }, 'a refused login is waiting too');
    assert.equal(transport.calls.sends.length, 1, 'asking again never sends a second mail');
});

test('60 s without the mail: the add fails, the real Application No is freed and everything is logged', { skip }, async () => {
    const s = await newStudent();
    const transport = fakeTransport({ deliver: false });
    await quiet(() => mt.sendFirstTestMail(s, WHO, fakeMigadu, transport));
    await age(s.email, 61);
    assert.deepEqual(await look(s.email, transport), { state: 'failed' });
    const r = await row(s.email);
    assert.match(r.admission_id, /^99\d{10}$/);
    assert.ok(r.deleted_at, 'hidden for good');
    assert.equal(r.mailbox_confirmed_at, null);
    assert.equal(Object.keys(await students.usedApplicationNumbers('1', ['32237'])).length, 0, 'the real number can be added again');
    const failed = (await events()).find((e) => e.event === 'add-failed').details;
    assert.equal(failed.applicationNo, '32237');
    assert.equal(failed.newApplicationNo, r.admission_id);
    assert.equal(failed.email, s.email);
    assert.equal(failed.mailboxKept, s.email);
    assert.equal(failed.reason, 'no test email after 60 s');
    assert.ok(failed.waitedSeconds >= 60);
    assert.deepEqual(failed.steps.map((x) => x.event), ['test-sent']);
    assert.deepEqual(await look(s.email, transport), { state: 'failed' }, 'asking again stays failed');
});

test('a late mail after the add failed changes nothing (central sync or a look)', { skip }, async () => {
    const s = await newStudent();
    const transport = fakeTransport({ deliver: false });
    await quiet(() => mt.sendFirstTestMail(s, WHO, fakeMigadu, transport));
    await age(s.email, 61);
    await look(s.email, transport);
    const messageId = `<mailbox-test-${s.id}@example.test>`;
    transport.inbox.add(messageId);
    await quiet(() => mt.confirmFromTestMail(s.email, messageId));
    assert.deepEqual(await look(s.email, transport), { state: 'failed' });
    const r = await row(s.email);
    assert.equal(r.mailbox_confirmed_at, null);
    assert.ok(r.deleted_at);
});

test('the central sync never stores the TEST email, and seeing it confirms the student', { skip }, async () => {
    const s = await newStudent();
    const parsed = (headers) => ({ headers: new Map(headers), subject: mt.TEST_SUBJECT, text: 'TEST', date: new Date(), references: undefined });
    const messageId = `<mailbox-test-${s.id}@example.test>`;
    assert.equal(await quiet(() => sync.insertMessageForStudent(parsed([['x-student-mail-test', '1']]), '<mailbox-test-999@example.test>', CENTRAL, s.email, new Date(), CENTRAL)), false);
    assert.equal((await row(s.email)).mailbox_confirmed_at, null, 'another student\'s test mail id confirms nothing');
    assert.equal(await quiet(() => sync.insertMessageForStudent(parsed([['x-student-mail-test', '1']]), messageId, CENTRAL, s.email, new Date(), CENTRAL)), false);
    assert.ok((await row(s.email)).mailbox_confirmed_at);
    assert.equal((await events()).at(-1).details.via, 'central sync');
    assert.equal(await sync.insertMessageForStudent(parsed([]), '<normal@example.test>', CENTRAL, s.email, new Date(), CENTRAL), true, 'other mail from central is stored');
    assert.deepEqual((await t.pool.query('SELECT message_id FROM messages')).rows.map((r) => r.message_id), ['<normal@example.test>']);
});

test('the test mail is recognised by its header AND the central mailbox as sender', { skip }, () => {
    const withHeader = { headers: new Map([['x-student-mail-test', '1']]) };
    assert.equal(mt.isMailboxTestMail(withHeader, 'Central@Example.test', CENTRAL), true);
    assert.equal(mt.isMailboxTestMail(withHeader, 'stranger@example.test', CENTRAL), false);
    assert.equal(mt.isMailboxTestMail({ headers: new Map() }, CENTRAL, CENTRAL), false);
});

test('dialog closed: the server check fails a stale add, confirms one whose mail arrived, leaves a fresh one', { skip }, async () => {
    const stale = await newStudent({ email: 'stale@example.test', admission: '1' });
    const arrived = await newStudent({ email: 'arrived@example.test', admission: '2' });
    const fresh = await newStudent({ email: 'fresh@example.test', admission: '3' });
    await age(stale.email, 100);
    await age(arrived.email, 100);
    const transport = fakeTransport();
    transport.inbox.add(`<mailbox-test-${arrived.id}@example.test>`);
    assert.equal(await quiet(() => mt.failStaleAdds(transport)), 1);
    assert.ok((await row(stale.email)).deleted_at);
    assert.match((await events()).find((e) => e.event === 'add-failed').details.reason, /dialog was closed/);
    assert.ok((await row(arrived.email)).mailbox_confirmed_at);
    const f = await row(fresh.email);
    assert.equal(f.deleted_at, null);
    assert.equal(f.admission_id, '3');
});

test('only a student of this college and central mailbox, added in the last hour', { skip }, async () => {
    const other = await b.college('Other College');
    const otherCollege = await newStudent({ email: 'oc@example.test', college: Number(other) });
    const otherCentral = await newStudent({ email: 'ocm@example.test', central: 'other@example.test', admission: '9' });
    const old = await newStudent({ email: 'old@example.test', admission: '8' });
    await age(old.email, 61 * 60);
    for (const email of [otherCollege.email, otherCentral.email, old.email, 'nobody@example.test']) {
        assert.equal(await look(email, fakeTransport()), null, email);
    }
});

test('students that were already there (or imported) count as confirmed', { skip }, async () => {
    await b.student({ first: 'Old', last: 'Hand' });
    assert.equal((await admin.searchAdminStudents({ centralEmail: CENTRAL, search: 'Old Hand' })).students.length, 1);
});

test('the status card lists the last 7 days newest first, and old entries are pruned after 30 days', { skip }, async () => {
    await quiet(() => addLog.audit('mailbox-created', { email: 'a@example.test' }));
    await quiet(() => addLog.audit('student-add', { email: 'a@example.test', outcome: 'added' }));
    await t.pool.query("INSERT INTO student_add_log (at, event, details) VALUES (now() - interval '8 days', 'test-sent', '{}'), (now() - interval '31 days', 'test-sent', '{}')");
    const status = await addLog.addLogStatus();
    assert.deepEqual(status.entries.map((e) => [e.event, e.email, e.outcome]), [['student-add', 'a@example.test', 'added'], ['mailbox-created', 'a@example.test', undefined]]);
    await addLog.pruneOldEntries();
    assert.equal((await t.pool.query('SELECT count(*)::int AS n FROM student_add_log')).rows[0].n, 3);
});

test('recording a log entry never throws, even when the table is gone', { skip }, async () => {
    await t.pool.query('ALTER TABLE student_add_log RENAME TO student_add_log_away');
    try {
        await quiet(() => addLog.audit('test-sent', { email: 'x@example.test' }));
    } finally {
        await t.pool.query('ALTER TABLE student_add_log_away RENAME TO student_add_log');
    }
});
