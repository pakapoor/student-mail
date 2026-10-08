// The Migadu mailbox client (src/migadu.ts) against a fake fetch: the request
// it sends (URL, method, Basic auth, body) and how it reads each answer.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { migaduMailboxApi } from '../src/migadu.ts';

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
