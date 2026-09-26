import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Fake sessions table (no real database).
const rows = new Map();
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
mock.module('../src/db.ts', { exports: { db: { query: async (sql, params = []) => {
    if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) return { rowCount: 0, rows: [] };
    if (sql.startsWith('INSERT INTO sessions')) { rows.set(params[0], { email: params[1], expires_at: params[2], college_id: null }); return { rowCount: 1, rows: [] }; }
    if (sql.startsWith('UPDATE sessions')) {
        const r = rows.get(params[0]);
        if (!r || r.expires_at <= new Date()) return { rowCount: 0, rows: [] };
        r.college_id = params[1]; return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE token_hash')) { rows.delete(params[0]); return { rowCount: 1, rows: [] }; }
    if (sql.includes('FROM sessions s')) {
        const r = rows.get(params[0]);
        if (!r || r.expires_at <= new Date()) return { rows: [] };
        return { rows: [{ email: r.email, expires_at: r.expires_at, college_id: r.college_id, college_name: r.college_id ? 'KSMA CENTRAL' : null }] };
    }
    throw new Error('unexpected SQL: ' + sql);
} } } });
const { createSession, getSession, setSessionCollege, destroySession } = await import('../src/auth.ts');

test('only a hash of the session token is stored', async () => {
    const token = await createSession('central@example.test');
    assert.ok(rows.has(hash(token)));
    assert.ok(![...rows.keys()].includes(token));
});

test('a session survives a backend restart (loaded from the table)', async () => {
    // A token the in-memory cache has never seen - as after a restart.
    const token = 'token-from-before-restart';
    rows.set(hash(token), { email: 'central@example.test', expires_at: new Date(Date.now() + 60000), college_id: '1' });
    const session = await getSession(token);
    assert.equal(session.email, 'central@example.test');
    assert.deepEqual(session.college, { id: '1', name: 'KSMA CENTRAL' });
});

test('college choice is persisted and logout removes the session', async () => {
    const token = await createSession('central@example.test');
    assert.equal(await setSessionCollege(token, { id: '1', name: 'KSMA CENTRAL' }), true);
    assert.equal(rows.get(hash(token)).college_id, '1');
    assert.equal((await getSession(token)).college.id, '1');
    await destroySession(token);
    assert.equal(rows.has(hash(token)), false);
    assert.equal(await getSession(token), undefined);
});

test('expired and unknown sessions are rejected', async () => {
    const token = 'expired-token';
    rows.set(hash(token), { email: 'central@example.test', expires_at: new Date(Date.now() - 1000), college_id: null });
    assert.equal(await getSession(token), undefined);
    assert.equal(await getSession('never-issued'), undefined);
    assert.equal(await getSession(undefined), undefined);
    assert.equal(await setSessionCollege(token, { id: '1', name: 'KSMA CENTRAL' }), false);
});
