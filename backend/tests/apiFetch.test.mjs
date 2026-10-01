// The frontend's logged-in fetch wrapper: a 401 reports "session ended" once
// per call (the console then shows Login instead of "(401)" errors); every
// other answer passes through untouched.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, setSessionEndedHandler } from '../../frontend/src/apiFetch.ts';

const realFetch = globalThis.fetch;
let calls;
const answer = (status) => {
    globalThis.fetch = async () => new Response(status === 204 ? null : '{}', { status });
};

beforeEach(() => {
    calls = 0;
    setSessionEndedHandler(() => calls++);
});
afterEach(() => {
    globalThis.fetch = realFetch;
    setSessionEndedHandler(null);
});

test('a 401 tells the app the session ended and still returns the response', async () => {
    answer(401);
    const res = await apiFetch('/api/threads');
    assert.equal(res.status, 401);
    assert.equal(calls, 1);
});

test('other statuses do not end the session', async () => {
    for (const status of [200, 204, 400, 403, 404, 500, 502]) {
        answer(status);
        const res = await apiFetch('/api/threads');
        assert.equal(res.status, status);
    }
    assert.equal(calls, 0);
});

test('each 401 is reported, so several failing calls are all handled', async () => {
    answer(401);
    await Promise.all([apiFetch('/a'), apiFetch('/b'), apiFetch('/c')]);
    assert.equal(calls, 3);
});

test('no handler registered: a 401 is returned without error', async () => {
    setSessionEndedHandler(null);
    answer(401);
    assert.equal((await apiFetch('/x')).status, 401);
});

test('the request is passed through unchanged, and network errors still throw', async () => {
    let seen;
    globalThis.fetch = async (input, init) => {
        seen = [input, init];
        return new Response('{}', { status: 200 });
    };
    await apiFetch('/api/threads?x=1', { credentials: 'include' });
    assert.deepEqual(seen, ['/api/threads?x=1', { credentials: 'include' }]);
    globalThis.fetch = async () => {
        throw new TypeError('network down');
    };
    await assert.rejects(() => apiFetch('/x'), /network down/);
    assert.equal(calls, 0);
});

test('unregistering a replaced handler does not remove the newer one', async () => {
    const unregisterOld = setSessionEndedHandler(() => {});
    setSessionEndedHandler(() => calls++);
    unregisterOld();
    answer(401);
    await apiFetch('/x');
    assert.equal(calls, 1);
});
