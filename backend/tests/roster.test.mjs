import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Fake database: records each query. The bucket rules themselves are SQL
// (studentsAdmin.ts EDUGATE_STATE_SQL) and were checked against a real dev
// Postgres; this covers the filter/count wiring around them.
const calls = [];
let rows = [];
mock.module('../src/db.ts', { exports: { db: { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('count(*) AS "all"')) return { rows: [{ all: '7', code_live: '1', code_expired: '2', registered: '3', rejected: '1' }] };
    return { rows };
} } } });
mock.module('../src/thread.ts', { exports: { countEffectivelyPendingByEmail: async () => ({}) } });
const { searchAdminStudents, ROSTER_FILTERS } = await import('../src/studentsAdmin.ts');

test('first page returns per-button counts for the current search', async () => {
    calls.length = 0; rows = [];
    const page = await searchAdminStudents({ centralEmail: 'c@example.test', collegeId: '1', search: 'ann' });
    assert.deepEqual(page.counts, { all: 7, code_live: 1, code_expired: 2, registered: 3, rejected: 1 });
    const countCall = calls.find(c => c.sql.includes('count(*) AS "all"'));
    assert.deepEqual(countCall.params, ['c@example.test', '1', '%ann%'], 'counts use scope + search only, not the button');
});

test('a pressed button filters the page by bucket', async () => {
    calls.length = 0; rows = [];
    await searchAdminStudents({ centralEmail: 'c@example.test', collegeId: '1', status: 'rejected' });
    const pageCall = calls.find(c => c.sql.includes('SELECT * FROM roster'));
    assert.match(pageCall.sql, /edugate_state = \$3/);
    assert.equal(pageCall.params[2], 'rejected');
});

test('later pages skip the count query', async () => {
    calls.length = 0; rows = [];
    const cursor = Buffer.from('A\u0000B\u00005', 'utf8').toString('base64');
    const page = await searchAdminStudents({ centralEmail: 'c@example.test', collegeId: '1', cursor });
    assert.equal(page.counts, undefined);
    assert.equal(calls.length, 1);
});

test('filters match the console names', () => {
    assert.deepEqual(ROSTER_FILTERS, ['code_live', 'code_expired', 'registered', 'rejected']);
});
