// The Migadu mailbox client (src/migadu.ts) against a fake fetch: the request
// it sends (URL, method, Basic auth, body) and how it reads each answer.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { migaduMailboxApi, minutesSinceCreated, callOutcome, REQUEST_TIMEOUT_MS } from '../src/migadu.ts';

const realFetch = globalThis.fetch;
const env = { MIGADU_ADMIN_EMAIL: 'admin@example.test', MIGADU_API_KEY: 'key-123', MIGADU_DOMAIN: undefined };
const saved = { ...process.env };

function setEnv(values) {
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
}

// Replace fetch with one that records the call and answers with `reply`.
function fakeFetch(reply) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return reply;
    };
    return calls;
}

const answer = (status, payload) => new Response(payload === undefined ? null : JSON.stringify(payload), { status });

afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
});

test('missing credentials fail before any request is made', () => {
    setEnv({ MIGADU_ADMIN_EMAIL: undefined, MIGADU_API_KEY: undefined });
    const calls = fakeFetch(answer(200));
    assert.throws(() => migaduMailboxApi(), /not set up/);
    assert.equal(calls.length, 0);
});

test('the domain defaults to myemailinfo.com and can be set', () => {
    setEnv({ ...env });
    assert.equal(migaduMailboxApi().domain, 'myemailinfo.com');
    setEnv({ ...env, MIGADU_DOMAIN: 'other.test' });
    assert.equal(migaduMailboxApi().domain, 'other.test');
});

test('exists: 200 is true, 404 is false, anything else is an error', async () => {
    setEnv({ ...env });
    const api = migaduMailboxApi();
    fakeFetch(answer(200, {}));
    assert.equal(await api.exists('a.b'), true);
    fakeFetch(answer(404, { error: 'not found' }));
    assert.equal(await api.exists('a.b'), false);
    fakeFetch(answer(500, { error: 'boom' }));
    await assert.rejects(api.exists('a.b'), /Migadu mailbox lookup failed \(500\): boom/);
});

test('lookup is a GET to the mailbox URL with Basic auth built from the admin email and key', async () => {
    setEnv({ ...env });
    const calls = fakeFetch(answer(404));
    await migaduMailboxApi().exists('a.b');
    assert.equal(calls[0].url, 'https://api.migadu.com/v1/domains/myemailinfo.com/mailboxes/a.b');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('admin@example.test:key-123').toString('base64')}`);
});

test('create: POSTs name, local part and password to the mailboxes URL', async () => {
    setEnv({ ...env });
    const calls = fakeFetch(answer(200, { address: 'a.b@myemailinfo.com' }));
    await migaduMailboxApi().create('a.b', 'A B', 'password');
    assert.equal(calls[0].url, 'https://api.migadu.com/v1/domains/myemailinfo.com/mailboxes');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'A B', local_part: 'a.b', password: 'password' });
});

test('create: a refusal becomes an error carrying Migadu\'s message, never the credentials', async () => {
    setEnv({ ...env });
    fakeFetch(answer(403, { error: 'mailbox limit reached' }));
    await assert.rejects(migaduMailboxApi().create('a.b', 'A B', 'password'), (error) => {
        assert.match(error.message, /Migadu mailbox creation failed \(403\): mailbox limit reached/);
        assert.doesNotMatch(error.message, /key-123|admin@example\.test/);
        return true;
    });
});

test('an answer without a JSON body still gives a clear error', async () => {
    setEnv({ ...env });
    fakeFetch(new Response('<html>bad gateway</html>', { status: 502 }));
    await assert.rejects(migaduMailboxApi().create('a.b', 'A B', 'password'), /Migadu mailbox creation failed \(502\)$/);
});

test('remove: DELETE succeeds on 200 and on 404 (already gone), fails otherwise', async () => {
    setEnv({ ...env });
    const api = migaduMailboxApi();
    const calls = fakeFetch(answer(200, {}));
    await api.remove('a.b');
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].url, 'https://api.migadu.com/v1/domains/myemailinfo.com/mailboxes/a.b');
    fakeFetch(answer(404));
    await api.remove('a.b');
    fakeFetch(answer(500, { error: 'nope' }));
    await assert.rejects(api.remove('a.b'), /Migadu mailbox removal failed \(500\)/);
});

test('a local part is URL-encoded in the path', async () => {
    setEnv({ ...env });
    const calls = fakeFetch(answer(404));
    await migaduMailboxApi().exists('a/b?c');
    assert.equal(calls[0].url, 'https://api.migadu.com/v1/domains/myemailinfo.com/mailboxes/a%2Fb%3Fc');
});

test('each call to Migadu waits at most 20 seconds', () => {
    assert.equal(REQUEST_TIMEOUT_MS, 20000);
});

test('a creation time shown as HH:MM is today (UTC): minutes ago; a date, nothing or the future is unknown', () => {
    const now = new Date('2026-10-08T08:30:00Z');
    assert.equal(minutesSinceCreated('08:28', now), 2);
    assert.equal(minutesSinceCreated('08:30', now), 0);
    assert.equal(minutesSinceCreated('08:31', now), 0, 'a minute ahead is clock difference');
    assert.equal(minutesSinceCreated('08:40', now), null, 'later than now is not today');
    assert.equal(minutesSinceCreated('29/09/26', now), null);
    assert.equal(minutesSinceCreated(undefined, now), null);
    assert.equal(minutesSinceCreated('', now), null);
});

test('inspect: the name and how long ago it was made; null when there is no such mailbox', async () => {
    setEnv({ ...env });
    const api = migaduMailboxApi();
    const hh = new Date(Date.now() - 3 * 60000);
    const stamp = `${String(hh.getUTCHours()).padStart(2, '0')}:${String(hh.getUTCMinutes()).padStart(2, '0')}`;
    fakeFetch(answer(200, { name: 'SAM LEE', activated_at: stamp }));
    const info = await api.inspect('sam.lee');
    assert.equal(info.name, 'SAM LEE');
    assert.ok(info.createdMinutesAgo === null || (info.createdMinutesAgo >= 2 && info.createdMinutesAgo <= 4), `got ${info.createdMinutesAgo}`);
    fakeFetch(answer(200, { name: 'RAJAT', activated_at: '29/09/26' }));
    assert.deepEqual(await api.inspect('rajat'), { name: 'RAJAT', createdMinutesAgo: null });
    fakeFetch(answer(404, { error: 'not found' }));
    assert.equal(await api.inspect('nobody'), null);
    fakeFetch(answer(500, { error: 'boom' }));
    await assert.rejects(api.inspect('sam.lee'), /Migadu mailbox lookup failed \(500\)/);
});

// ---- timing of every call (for the status page graph)
test('every call is timed and reported with what it was and how it ended', async () => {
    setEnv({ ...env });
    const calls = [];
    const api = migaduMailboxApi((c) => calls.push(c));
    fakeFetch(answer(200, {}));
    await api.exists('a.b');
    fakeFetch(answer(404, {}));
    await api.exists('a.b');
    fakeFetch(answer(200, {}));
    await api.create('a.b', 'A B', 'password');
    fakeFetch(answer(404));
    await api.remove('a.b');
    assert.deepEqual(calls.map((c) => [c.operation, c.outcome]), [['lookup', 'ok'], ['lookup', 'ok'], ['create', 'ok'], ['remove', 'ok']]);
    assert.ok(calls.every((c) => Number.isInteger(c.ms) && c.ms >= 0 && c.ms < 1000));
});

test('how a call ended: refused, server error, network error, timeout', async () => {
    setEnv({ ...env });
    const calls = [];
    const api = migaduMailboxApi((c) => calls.push(c));
    fakeFetch(answer(400, { error: 'bad request' }));
    await assert.rejects(api.create('a.b', 'A B', 'password'));
    fakeFetch(answer(502, {}));
    await assert.rejects(api.exists('a.b'));
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api.exists('a.b'));
    globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    await assert.rejects(api.create('a.b', 'A B', 'password'));
    assert.deepEqual(calls.map((c) => [c.operation, c.outcome]), [['create', 'refused'], ['lookup', 'server-error'], ['lookup', 'network'], ['create', 'timeout']]);
});

test('callOutcome: a 404 is only normal for a lookup or a removal, not a creation', () => {
    assert.equal(callOutcome('lookup', 404), 'ok');
    assert.equal(callOutcome('remove', 404), 'ok');
    assert.equal(callOutcome('create', 404), 'refused');
    assert.equal(callOutcome('create', 201), 'ok');
    assert.equal(callOutcome('create', 500), 'server-error');
});

test('a recorder that throws never breaks the call', async () => {
    setEnv({ ...env });
    const api = migaduMailboxApi(() => { throw new Error('recorder broke'); });
    fakeFetch(answer(200, {}));
    assert.equal(await api.exists('a.b'), true);
});
