// Step 53: database calls can never wait forever, and PostgreSQL closing our
// connection (Ubuntu's automatic updates restart it) never crashes the
// backend - it did on 2026-10-02, 10-09 and 10-23. Real PostgreSQL where it
// matters.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import pg from 'pg';
import { startTestDb } from './helpers/testdb.mjs';
import { poolOptions, onPoolError, db, DB_CONNECT_TIMEOUT_MS, DB_QUERY_TIMEOUT_MS } from '../src/db.ts';

const t = await startTestDb({ schema: false });
const skip = t ? false : 'no PostgreSQL server binaries available';
after(async () => { await db.end().catch(() => {}); await t?.stop(); });

// A pool like the app's, pointed at the throwaway database, with short limits.
const testPool = (over = {}) => {
    const pool = new pg.Pool({ ...poolOptions({ DB_HOST: '127.0.0.1', DB_PORT: String(t.port), DB_NAME: 'app', DB_USER: 'test' }), ...over });
    pool.on('error', onPoolError);
    return pool;
};

test('the app pool has a 10 s connect limit and a 30 s query limit', () => {
    const o = poolOptions({});
    assert.equal(o.connectionTimeoutMillis, 10000);
    assert.equal(o.query_timeout, 30000);
    assert.equal(o.statement_timeout, 30000);
    assert.equal(DB_CONNECT_TIMEOUT_MS, 10000);
    assert.equal(DB_QUERY_TIMEOUT_MS, 30000);
});

test('the app pool reads its connection settings from the environment', () => {
    const o = poolOptions({ DB_HOST: 'h', DB_PORT: '6543', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p' });
    assert.deepEqual([o.host, o.port, o.database, o.user, o.password], ['h', 6543, 'n', 'u', 'p']);
});

test('the app pool has an error listener (an idle connection error is not fatal)', () => {
    assert.ok(db.listenerCount('error') >= 1);
});

test('the error listener only logs; it never throws', t2 => {
    const errors = t2.mock.method(console, 'error', () => {});
    onPoolError(new Error('terminating connection due to administrator command'));
    assert.equal(errors.mock.calls.length, 1);
});

test('PostgreSQL killing our idle connection: no crash, the next query works', { skip }, async t2 => {
    const errors = t2.mock.method(console, 'error', () => {});
    const pool = testPool();
    const pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await t.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(errors.mock.calls.some(c => /idle connection error/.test(String(c.arguments[0]))), 'logged, not thrown');
    assert.equal((await pool.query('SELECT 1 AS one')).rows[0].one, 1);
    await pool.end();
});

test('PostgreSQL killing every connection at once (a restart): the pool recovers', { skip }, async t2 => {
    t2.mock.method(console, 'error', () => {});
    const pool = testPool({ max: 3 });
    await Promise.all([1, 2, 3].map(() => pool.query('SELECT pg_sleep(0.05)')));
    await t.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'app' AND pid <> pg_backend_pid() AND application_name = ''");
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await pool.query('SELECT 2 AS two')).rows[0].two, 2);
    await pool.end();
});

test('a query running too long is cancelled by the server (statement_timeout)', { skip }, async () => {
    const pool = testPool({ statement_timeout: 200, query_timeout: 5000 });
    await assert.rejects(pool.query('SELECT pg_sleep(2)'), /statement timeout/);
    assert.equal((await pool.query('SELECT 1 AS one')).rows[0].one, 1, 'the pool still works after');
    await pool.end();
});

test('a query whose answer never comes is given up by the client (query_timeout)', { skip }, async () => {
    const pool = testPool({ statement_timeout: 0, query_timeout: 200 });
    await assert.rejects(pool.query('SELECT pg_sleep(2)'), /timeout/i);
    await pool.end();
});

test('a server that accepts but never answers: connecting gives up (no hang)', async () => {
    const sockets = [];
    const silent = net.createServer((s) => { sockets.push(s); });
    await new Promise(r => silent.listen(0, '127.0.0.1', r));
    const pool = new pg.Pool({ ...poolOptions({ DB_HOST: '127.0.0.1', DB_PORT: String(silent.address().port) }), connectionTimeoutMillis: 300 });
    pool.on('error', () => {});
    const started = Date.now();
    await assert.rejects(pool.query('SELECT 1'), /timeout/i);
    assert.ok(Date.now() - started < 3000);
    await pool.end().catch(() => {});
    sockets.forEach(s => s.destroy());
    silent.close();
});

test('a database that is down: the query fails at once, it does not hang', async () => {
    const pool = new pg.Pool({ ...poolOptions({ DB_HOST: '127.0.0.1', DB_PORT: '1' }), connectionTimeoutMillis: 2000 });
    pool.on('error', () => {});
    await assert.rejects(pool.query('SELECT 1'));
    await pool.end().catch(() => {});
});

test('pool exhausted by stuck queries: the next caller gets an error, not a forever-wait', { skip }, async () => {
    const pool = testPool({ max: 2, connectionTimeoutMillis: 300, statement_timeout: 0, query_timeout: 0 });
    const stuck = [pool.query('SELECT pg_sleep(3)'), pool.query('SELECT pg_sleep(3)')];
    const started = Date.now();
    await assert.rejects(pool.query('SELECT 1'), /timeout/i);
    assert.ok(Date.now() - started < 2000);
    await Promise.allSettled(stuck);
    await pool.end();
});

test('a leaked client (never released) cannot freeze others forever', { skip }, async () => {
    const pool = testPool({ max: 1, connectionTimeoutMillis: 300 });
    const leaked = await pool.connect();
    await assert.rejects(pool.query('SELECT 1'), /timeout/i);
    leaked.release();
    assert.equal((await pool.query('SELECT 3 AS three')).rows[0].three, 3);
    await pool.end();
});
