import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, builders } from './helpers/testdb.mjs';
import { applyRegistrationEvent } from '../src/registrationStatus.ts';

const t = await startTestDb();
const skip = !t;
const b = t && builders(t.pool);
const migration = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations/015_rejected_at.sql');
after(() => t?.stop());
beforeEach(() => t?.reset());
const at = (minutes) => new Date(Date.now() - minutes * 60_000);
const state = async (email) => (await t.pool.query(
    'SELECT code_sent_at, registered_at, rejected_at, registration_status FROM students WHERE email = $1', [email]
)).rows[0];

test('015 backfills the newest rejection by sent time, reruns without rewriting, and repairs stale dates', { skip }, async () => {
    const a = await b.student({ email: 'a@example.test' });
    const c = await b.student({ email: 'c@example.test' });
    await b.message({ student: a, kind: 'rejected', at: at(400), sent: at(300) });
    await b.message({ student: a, kind: 'rejected', at: at(100), sent: at(200) });
    await b.message({ student: c, kind: 'rejected', at: at(50), sent: null });
    let result = t.runSqlFile(migration);
    assert.equal(result.ok, true, result.stderr);
    assert.ok(Math.abs((await state(a)).rejected_at - at(200)) < 2000);
    assert.ok(Math.abs((await state(c)).rejected_at - at(50)) < 2000);

    const before = (await t.pool.query('SELECT xmin::text AS version FROM students WHERE email = $1', [a])).rows[0].version;
    result = t.runSqlFile(migration);
    assert.equal(result.ok, true, result.stderr);
    const afterRerun = (await t.pool.query('SELECT xmin::text AS version FROM students WHERE email = $1', [a])).rows[0].version;
    assert.equal(afterRerun, before, 'a second run does not rewrite correct rows');

    await t.pool.query('DELETE FROM messages WHERE student_email = $1', [c]);
    await t.pool.query('UPDATE students SET rejected_at = now() WHERE email = $1', [c]);
    result = t.runSqlFile(migration);
    assert.equal(result.ok, true, result.stderr);
    assert.equal((await state(c)).rejected_at, null, 'a stale rejection is cleared');
});

test('a rejection records its date without changing code or registration status', { skip }, async () => {
    const s = await b.student();
    await applyRegistrationEvent(s, 'code', at(90), t.pool);
    await applyRegistrationEvent(s, 'rejected', at(30), t.pool);
    let got = await state(s);
    assert.equal(got.registration_status, 'REGISTRATION_PENDING');
    assert.ok(got.rejected_at > got.code_sent_at);
    await applyRegistrationEvent(s, 'login', at(20), t.pool);
    got = await state(s);
    assert.equal(got.registration_status, 'REGISTERED');
    assert.ok(got.registered_at > got.rejected_at);
});

test('deleting or correcting Edugate mail recomputes cached dates from remaining mail', { skip }, async () => {
    const s = await b.student();
    const code = await b.message({ student: s, kind: 'code', sent: at(90) });
    const login = await b.message({ student: s, kind: 'login', sent: at(30) });
    await applyRegistrationEvent(s, 'code', at(90), t.pool);
    await applyRegistrationEvent(s, 'login', at(30), t.pool);
    await t.pool.query('DELETE FROM messages WHERE id = $1', [login.id]);
    assert.equal((await state(s)).registration_status, 'REGISTRATION_PENDING');
    assert.equal((await state(s)).registered_at, null);
    await t.pool.query("UPDATE messages SET edugate_kind = 'rejected' WHERE id = $1", [code.id]);
    const got = await state(s);
    assert.equal(got.code_sent_at, null);
    assert.equal(got.registration_status, null);
    assert.ok(got.rejected_at);
});

test('moving Edugate mail between students refreshes both records', { skip }, async () => {
    const a = await b.student({ email: 'a@example.test' });
    const c = await b.student({ email: 'c@example.test' });
    const login = await b.message({ student: a, kind: 'login', sent: at(30) });
    await applyRegistrationEvent(a, 'login', at(30), t.pool);
    await t.pool.query('UPDATE messages SET student_email = $1 WHERE id = $2', [c, login.id]);
    assert.equal((await state(a)).registered_at, null);
    assert.equal((await state(a)).registration_status, null);
    assert.equal((await state(c)).registration_status, 'REGISTERED');
});

test('changing student email refreshes rejection from the normalized new address', { skip }, async () => {
    const old = await b.student({ email: 'old@example.test' });
    await b.message({ student: 'new@example.test', kind: 'rejected', sent: at(20) });
    await t.pool.query("UPDATE students SET email = 'New@Example.Test' WHERE email = $1", [old]);
    assert.ok(Math.abs((await state('new@example.test')).rejected_at - at(20)) < 2000);
});
