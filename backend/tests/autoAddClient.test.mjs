// The browser's call to add students (frontend/src/autoAddClient.ts) against a
// fake fetch: whatever goes wrong, the clerk gets a plain sentence, never a
// parsing error, and a request that never answers ends instead of hanging.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { postAutoAdd, postCheckNumbers } from '../../frontend/src/autoAddClient.ts';
import { setSessionEndedHandler } from '../../frontend/src/apiFetch.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setSessionEndedHandler(null); });

const reply = (status, body, contentType = 'application/json') => () =>
    Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': contentType } }));

test('a good answer is returned as it is, and the request carries the csv, cookies and JSON', async () => {
    const answer = { added: 1, skipped: 0, failed: 0, rows: [{ line: 1, status: 'added' }] };
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify(answer), { status: 200 }); };
    assert.deepEqual(await postAutoAdd('/api/students/auto-add', 'Jane Doe,1'), answer);
    assert.equal(sent.url, '/api/students/auto-add');
    assert.equal(sent.init.method, 'POST');
    assert.equal(sent.init.credentials, 'include');
    assert.deepEqual(JSON.parse(sent.init.body), { csv: 'Jane Doe,1' });
});

test('an error message from the server is passed on as it is', async () => {
    globalThis.fetch = reply(400, { error: 'Add at most 10 students at a time (you pasted 11)' });
    await assert.rejects(postAutoAdd('/x', 'a'), /^Error: Add at most 10 students at a time \(you pasted 11\)$/);
});

test('a proxy error page (HTML, not JSON) becomes a plain sentence, not a parsing error', async () => {
    globalThis.fetch = reply(504, '<html><body>504 Gateway Time-out</body></html>', 'text/html');
    await assert.rejects(postAutoAdd('/x', 'a'), (error) => {
        assert.equal(error.message, 'The server is busy or restarting. Wait a moment and try again.');
        assert.doesNotMatch(error.message, /JSON|token|<|Unexpected/);
        return true;
    });
    globalThis.fetch = reply(502, 'Bad Gateway', 'text/html');
    await assert.rejects(postAutoAdd('/x', 'a'), /busy or restarting/);
});

test('other failures without a message get a plain sentence with the status', async () => {
    globalThis.fetch = reply(500, 'oops', 'text/plain');
    await assert.rejects(postAutoAdd('/x', 'a'), /^Error: Adding students failed \(500\)\. Try again\.$/);
});

test('a 401 tells the app the session ended and says so in plain words', async () => {
    let ended = 0;
    setSessionEndedHandler(() => { ended++; });
    globalThis.fetch = reply(401, 'Unauthorized', 'text/plain');
    await assert.rejects(postAutoAdd('/x', 'a'), /signed out/);
    assert.equal(ended, 1);
});

test('a dropped connection gives a plain sentence', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(postAutoAdd('/x', 'a'), (error) => {
        assert.equal(error.message, 'Could not reach the server. Check the internet connection and try again.');
        return true;
    });
});

test('a request that never answers ends after the time limit instead of hanging', async () => {
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const started = Date.now();
    await assert.rejects(postAutoAdd('/x', 'a', 50), /did not answer in time/);
    assert.ok(Date.now() - started < 2000);
});

test('an answer that is JSON but not the expected shape is refused', async () => {
    globalThis.fetch = reply(200, { hello: 'world' });
    await assert.rejects(postAutoAdd('/x', 'a'), /could not be read/);
});

// ---- the look-up of used Application Nos is advice only and fails quietly
test('the look-up sends the numbers and returns who has them', async () => {
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ used: { 30437: { name: 'ZUNAIRA SAQI', deleted: false } } }), { status: 200 }); };
    const used = await postCheckNumbers('/api/students/check-numbers', ['30437', '5']);
    assert.deepEqual(used, { 30437: { name: 'ZUNAIRA SAQI', deleted: false } });
    assert.deepEqual(JSON.parse(sent.init.body), { numbers: ['30437', '5'] });
    assert.equal(sent.init.credentials, 'include');
});

test('no numbers means no request at all', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('{}'); };
    assert.deepEqual(await postCheckNumbers('/x', []), {});
    assert.equal(calls, 0);
});

test('any problem with the look-up (server error, HTML page, dropped connection, no answer) means "nothing known", never an error', async () => {
    globalThis.fetch = reply(500, { error: 'boom' });
    assert.deepEqual(await postCheckNumbers('/x', ['5']), {});
    globalThis.fetch = reply(504, '<html>timeout</html>', 'text/html');
    assert.deepEqual(await postCheckNumbers('/x', ['5']), {});
    globalThis.fetch = reply(200, { hello: 'world' });
    assert.deepEqual(await postCheckNumbers('/x', ['5']), {});
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    assert.deepEqual(await postCheckNumbers('/x', ['5']), {});
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    assert.deepEqual(await postCheckNumbers('/x', ['5'], 50), {});
});
