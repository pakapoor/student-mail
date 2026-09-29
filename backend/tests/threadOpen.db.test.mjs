// Opening a thread (fetchThread) against a real, throwaway PostgreSQL. It reads
// one student's messages and replies inside a single read-only snapshot, so
// the access check and the content cannot disagree (Step 31d).
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, builders } from './helpers/testdb.mjs';

const t = await startTestDb();
const skip = t ? false : 'no PostgreSQL server binaries available';
after(() => t?.stop());

let thread, b;
if (t) {
    mock.module('../src/db.ts', { exports: { db: t.pool } });
    thread = await import('../src/thread.ts');
    b = builders(t.pool);
}

const CENTRAL = 'central@example.test';
const minutesAgo = (m) => new Date(Date.now() - m * 60000);
const openThread = (id, college = '1', central = CENTRAL) => thread.fetchThread(Number(id), central, college);

beforeEach(async () => {
    if (t) await t.reset();
});

// -------------------------------------------------------------- fetchThread

test('opening a thread returns its messages and staff replies in time order', { skip }, async () => {
    const s = await b.student();
    const first = await b.message({ student: s, at: minutesAgo(60), id: '<t1@test>', body: 'first' });
    await b.reply({ to: '<t1@test>', student: s, at: minutesAgo(50), body: 'our answer' });
    await b.message({ student: s, at: minutesAgo(40), id: '<t2@test>', inReplyTo: '<t1@test>', refs: ['<t1@test>'], body: 'second' });
    const items = await openThread(first.id);
    assert.deepEqual(items.map((i) => [i.type, i.body_text]), [['incoming', 'first'], ['outgoing', 'our answer'], ['incoming', 'second']]);
});

test('opening any message of a thread gives the same whole thread', { skip }, async () => {
    const s = await b.student();
    const a = await b.message({ student: s, at: minutesAgo(60), id: '<u1@test>' });
    const c = await b.message({ student: s, at: minutesAgo(30), id: '<u2@test>', inReplyTo: '<u1@test>', refs: ['<u1@test>'] });
    const viaFirst = await openThread(a.id);
    const viaSecond = await openThread(c.id);
    assert.deepEqual(viaFirst.map((i) => i.id), viaSecond.map((i) => i.id));
    assert.equal(viaFirst.length, 2);
});

test('a thread never includes another thread of the same student', { skip }, async () => {
    const s = await b.student();
    const a = await b.message({ student: s, at: minutesAgo(60), id: '<v1@test>', subject: 'A' });
    await b.message({ student: s, at: minutesAgo(30), id: '<v2@test>', subject: 'B' });
    const items = await openThread(a.id);
    assert.deepEqual(items.map((i) => i.subject), ['A']);
});

test('two students who received the same Message-ID keep separate threads', { skip }, async () => {
    const s1 = await b.student();
    const s2 = await b.student();
    const m1 = await b.message({ student: s1, id: '<shared@test>', body: 'for one' });
    const m2 = await b.message({ student: s2, id: '<shared@test>', body: 'for two' });
    assert.deepEqual((await openThread(m1.id)).map((i) => i.body_text), ['for one']);
    assert.deepEqual((await openThread(m2.id)).map((i) => i.body_text), ['for two']);
});

test('a reply to one student never shows in another student\'s thread', { skip }, async () => {
    const s1 = await b.student();
    const s2 = await b.student();
    const m1 = await b.message({ student: s1, id: '<same@test>' });
    await b.message({ student: s2, id: '<same@test>' });
    await b.reply({ to: '<same@test>', student: s2, body: 'only for two' });
    assert.deepEqual((await openThread(m1.id)).map((i) => i.type), ['incoming']);
});

test('an unknown message id opens nothing', { skip }, async () => {
    assert.equal(await openThread(424242), null);
});

test('a message from another college, mailbox, or a deleted student opens nothing', { skip }, async () => {
    const other = await b.student({ college: 2 });
    const gone = await b.student({ deleted: true });
    const mine = await b.student();
    const a = await b.message({ student: other });
    const c = await b.message({ student: gone });
    const d = await b.message({ student: mine, central: 'elsewhere@example.test' });
    assert.equal(await openThread(a.id, '1'), null);
    assert.ok(await openThread(a.id, '2'));
    assert.equal(await openThread(c.id), null);
    assert.equal(await openThread(d.id), null);
    assert.ok(await openThread(d.id, '1', 'elsewhere@example.test'));
});

test('a thread read keeps one authorization snapshot after the student moves', { skip }, async () => {
    const student = await b.student({ email: 'moving@example.test' });
    const rejection = await b.message({
        student, sender: 'notify@edu.gov.kg', kind: 'rejected',
        body: b.rejection(), id: '<moving-rejection@test>'
    });
    const originalConnect = t.pool.connect;
    let hooked = false;

    t.pool.connect = async function (...args) {
        const client = await originalConnect.apply(this, args);
        if (hooked) return client;
        hooked = true;
        const originalQuery = client.query.bind(client);
        client.query = async (...queryArgs) => {
            const result = await originalQuery(...queryArgs);
            if (typeof queryArgs[0] === 'string' && queryArgs[0].includes('WHERE id = $1 AND central_email = $2')) {
                client.query = originalQuery;
                await t.pool.query('UPDATE students SET college_id = 2 WHERE email = $1', [student]);
                await b.reply({ to: rejection.messageId, student, body: 'after move' });
                await b.message({
                    student, sender: 'confirm@edu.gov.kg', kind: 'login',
                    body: b.login(student), id: '<moving-login@test>'
                });
            }
            return result;
        };
        return client;
    };

    try {
        const items = await openThread(rejection.id);
        assert.deepEqual(items.map((item) => item.type), ['incoming']);
        assert.equal(items[0].edugate_login, null, 'a later login is outside the authorized snapshot');
    } finally {
        t.pool.connect = originalConnect;
    }
    assert.equal(await openThread(rejection.id), null, 'a new request sees the move');
});

test('a code email sent before the student registered is shown as closed', { skip }, async () => {
    const s = await b.student();
    const code = await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'code', body: b.code(), at: minutesAgo(120), sent: minutesAgo(120) });
    await t.pool.query('UPDATE students SET registered_at = $2 WHERE email = $1', [s, minutesAgo(60)]);
    assert.equal((await openThread(code.id))[0].auto_closed, true);
});

test('a code email sent after registering is still open', { skip }, async () => {
    const s = await b.student();
    await t.pool.query('UPDATE students SET registered_at = $2 WHERE email = $1', [s, minutesAgo(120)]);
    const code = await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'code', body: b.code(), at: minutesAgo(10), sent: minutesAgo(10) });
    assert.equal((await openThread(code.id))[0].auto_closed, false);
});

test('a registration email warns when a newer one exists', { skip }, async () => {
    const s = await b.student();
    const old = await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'login', body: b.login(s, 'OldPass11'), at: minutesAgo(300), sent: minutesAgo(300) });
    await t.pool.query('UPDATE students SET registered_at = $2 WHERE email = $1', [s, minutesAgo(60)]);
    const item = (await openThread(old.id))[0];
    assert.ok(item.newer_login_at, 'a newer login exists');
    assert.equal(item.newer_edugate_at, null);
});

test('the newest registration email has no warning', { skip }, async () => {
    const s = await b.student();
    const at = minutesAgo(60);
    const login = await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'login', body: b.login(s), at, sent: at });
    await t.pool.query('UPDATE students SET registered_at = $2 WHERE email = $1', [s, at]);
    const item = (await openThread(login.id))[0];
    assert.equal(item.newer_login_at, null);
    assert.equal(item.newer_edugate_at, null);
});

test('an Edugate email we do not recognise, sent later, flags the password as possibly outdated', { skip }, async () => {
    const s = await b.student();
    const login = await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'login', body: b.login(s), at: minutesAgo(300), sent: minutesAgo(300) });
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: null, body: 'Your password was reset', at: minutesAgo(30), sent: minutesAgo(30), subject: 'Edugate' });
    assert.ok((await openThread(login.id))[0].newer_edugate_at);
});

test('a rejection email carries the student\'s login details from their latest registration email', { skip }, async () => {
    const s = await b.student({ email: 'rej@example.test' });
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'login', body: b.login(s, 'FirstPass1'), at: minutesAgo(600), sent: minutesAgo(600) });
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'login', body: b.login(s, 'SecondPass2'), at: minutesAgo(300), sent: minutesAgo(300) });
    const rej = await b.message({ student: s, sender: 'notify@edu.gov.kg', kind: 'rejected', body: b.rejection(), at: minutesAgo(60), sent: minutesAgo(60) });
    const item = (await openThread(rej.id)).find((i) => i.id === rej.id || String(i.id) === rej.id);
    assert.equal(item.edugate_login.login, 'rej@example.test');
    assert.equal(item.edugate_login.password, 'SecondPass2');
    assert.equal(item.edugate_login.newer_edugate_at, null);
});

test('a rejection for a student with no registration email has no login details', { skip }, async () => {
    const s = await b.student();
    const rej = await b.message({ student: s, sender: 'notify@edu.gov.kg', kind: 'rejected', body: b.rejection(), at: minutesAgo(60), sent: minutesAgo(60) });
    assert.equal((await openThread(rej.id))[0].edugate_login, null);
});

test('login details are looked up in the same mailbox only', { skip }, async () => {
    const s = await b.student();
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'login', body: b.login(s), at: minutesAgo(300), sent: minutesAgo(300), central: 'elsewhere@example.test' });
    const rej = await b.message({ student: s, sender: 'notify@edu.gov.kg', kind: 'rejected', body: b.rejection(), at: minutesAgo(60), sent: minutesAgo(60) });
    assert.equal((await openThread(rej.id))[0].edugate_login, null);
});

test('a rejection warns when a newer Edugate email we do not recognise exists, and not when it is older', { skip }, async () => {
    const s = await b.student({ email: 'warn@example.test' });
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'login', body: b.login(s), at: minutesAgo(300), sent: minutesAgo(300) });
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: null, body: 'Password changed', at: minutesAgo(200), sent: minutesAgo(200), subject: 'Edugate' });
    const rej = await b.message({ student: s, sender: 'notify@edu.gov.kg', kind: 'rejected', body: b.rejection(), at: minutesAgo(60), sent: minutesAgo(60) });
    assert.ok((await openThread(rej.id))[0].edugate_login.newer_edugate_at, 'the password may be outdated');
    await t.pool.query("UPDATE messages SET sent_at = now() - interval '400 minutes', received_at = now() - interval '400 minutes' WHERE edugate_kind IS NULL");
    assert.equal((await openThread(rej.id))[0].edugate_login.newer_edugate_at, null, 'an older unknown email does not warn');
});

test('login warnings and login details belong only to their own kind of email in a thread', { skip }, async () => {
    const s = await b.student({ email: 'mix@example.test' });
    const login = await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: 'login', body: b.login(s), at: minutesAgo(300), sent: minutesAgo(300), id: '<lg@test>' });
    await b.message({ student: s, at: minutesAgo(250), sent: minutesAgo(250), inReplyTo: '<lg@test>', refs: ['<lg@test>'], id: '<hu@test>', body: 'thanks' });
    await b.message({ student: s, sender: 'notify@edu.gov.kg', kind: 'rejected', body: b.rejection(), at: minutesAgo(200), sent: minutesAgo(200), inReplyTo: '<lg@test>', refs: ['<lg@test>'], id: '<rj@test>' });
    await t.pool.query('UPDATE students SET registered_at = $2 WHERE email = $1', [s, minutesAgo(100)]);
    await b.message({ student: s, sender: 'confirm@edu.gov.kg', kind: null, body: 'Password reset', at: minutesAgo(50), sent: minutesAgo(50), subject: 'Edugate' });
    const items = await openThread(login.id);
    const byId = Object.fromEntries(items.filter((i) => i.type === 'incoming').map((i) => [i.message_id, i]));
    assert.ok(byId['<lg@test>'].newer_login_at, 'the login email knows a newer registration exists');
    assert.ok(byId['<lg@test>'].newer_edugate_at, 'and a newer unrecognised Edugate email');
    assert.equal(byId['<hu@test>'].newer_login_at, null, 'an ordinary message has no login warning');
    assert.equal(byId['<hu@test>'].newer_edugate_at, null);
    assert.equal(byId['<hu@test>'].edugate_login, null, 'and no login details');
    assert.equal(byId['<lg@test>'].edugate_login, null, 'a login email carries no rejection details');
    assert.ok(byId['<rj@test>'].edugate_login, 'only the rejection carries the login details');
    assert.equal(byId['<rj@test>'].newer_login_at, null);
});

// ---------------------------------------------------- the replies lookup index

test('the replies table has an index on student_email, and the migration is safe to run twice', { skip }, async () => {
    const before = await t.pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_replies_student_email'");
    assert.equal(before.rowCount, 1, 'fresh schema has it');
    await t.pool.query('DROP INDEX idx_replies_student_email');
    for (let i = 0; i < 2; i++) {
        const r = t.runSqlFile(new URL('../migrations/016_replies_student_index.sql', import.meta.url).pathname);
        assert.ok(r.ok, r.stderr);
    }
    const after2 = await t.pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_replies_student_email'");
    assert.equal(after2.rowCount, 1);
});

test('opening a thread reads replies through the student_email index, not a scan', { skip }, async () => {
    const s = await b.student({});
    const m = await b.message({ student: s });
    await b.reply({ to: m.messageId, student: s });
    for (let i = 0; i < 300; i++) await t.pool.query("INSERT INTO replies (incoming_message_id, student_email, recipient_email) VALUES ($1, $2, 'x@example.test')", ['<r' + i + '@t>', 'other' + i + '@example.test']);
    await t.pool.query('ANALYZE replies');
    await t.pool.query('SET enable_seqscan = off');
    const plan = (await t.pool.query('EXPLAIN SELECT id FROM replies WHERE student_email = $1', [s])).rows.map((r) => r['QUERY PLAN']).join('\n');
    await t.pool.query('RESET enable_seqscan');
    assert.match(plan, /idx_replies_student_email/);
});
