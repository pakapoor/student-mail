import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('../src/db.ts', { exports: { db: { query: async () => ({ rows: [] }) } } });
const { applyRegistrationEvent, RECOMPUTE_ALL_SQL } = await import('../src/registrationStatus.ts');

const run = async (kind) => {
    const calls = [];
    await applyRegistrationEvent('Ann@Example.test', kind, '2026-09-29T10:00:00Z', { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
    assert.equal(calls.length, 1, 'one UPDATE per event');
    return calls[0];
};

test('every kind is one UPDATE of the student, matched by lower(email)', async () => {
    for (const kind of ['code', 'login', 'rejected']) {
        const { sql, params } = await run(kind);
        assert.match(sql, /UPDATE students SET/);
        assert.match(sql, /WHERE lower\(email\) = lower\(\$1\)/);
        assert.deepEqual(params, ['Ann@Example.test', kind, '2026-09-29T10:00:00Z']);
    }
});

test('a rejection moves rejected_at forward and never changes the registration status', async () => {
    const { sql } = await run('rejected');
    assert.match(sql, /rejected_at = CASE WHEN \$2 = 'rejected'\s+THEN GREATEST\(rejected_at, \$3::timestamptz\) ELSE rejected_at END/);
    assert.match(sql, /WHEN \$2 = 'rejected' THEN registration_status/, 'status is left as it was');
    // The status CASE must check the rejection first: a rejected student who has
    // not registered must not be turned into REGISTRATION_PENDING.
    assert.ok(sql.indexOf("WHEN $2 = 'rejected' THEN registration_status") < sql.indexOf("ELSE 'REGISTRATION_PENDING'"));
});

test('code and login keep their own columns; rejected_at only follows rejections', async () => {
    const { sql } = await run('code');
    assert.match(sql, /code_sent_at = CASE WHEN \$2 = 'code'/);
    assert.match(sql, /registered_at = CASE WHEN \$2 = 'login'/);
    assert.doesNotMatch(sql, /rejected_at = \$/, 'rejected_at is only ever set inside the rejected CASE');
});

test('the full recompute also rebuilds rejected_at', () => {
    assert.match(RECOMPUTE_ALL_SQL, /FILTER \(WHERE edugate_kind = 'rejected'\) AS rejected_at/);
    assert.match(RECOMPUTE_ALL_SQL, /edugate_kind IN \('code', 'login', 'rejected'\)/);
    assert.match(RECOMPUTE_ALL_SQL, /rejected_at = x\.rejected_at/);
});
