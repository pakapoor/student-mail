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
    if (sql.includes('GROUP BY st.college_id')) return { rows: [{ college_id: '1', n: '4' }, { college_id: '2', n: '2' }, { college_id: null, n: '1' }] };
    return { rows };
} } } });
mock.module('../src/thread.ts', { exports: { countEffectivelyPendingByEmail: async () => ({}) } });
const { searchAdminStudents, ROSTER_FILTERS } = await import('../src/studentsAdmin.ts');

test('first page returns per-button counts for the current search', async () => {
    calls.length = 0; rows = [];
    const page = await searchAdminStudents({ centralEmail: 'c@example.test', search: 'ann' });
    assert.deepEqual(page.counts, { all: 7, code_live: 1, code_expired: 2, registered: 3, rejected: 1 });
    const countCall = calls.find(c => c.sql.includes('count(*) AS "all"'));
    assert.deepEqual(countCall.params, ['c@example.test', '%ann%'], 'counts use mailbox + search only, not the button');
    assert.doesNotMatch(countCall.sql, /st\.college_id = /, 'no college filter unless a college button is pressed');
    assert.doesNotMatch(countCall.sql, /year_enrolled::text/, 'the year is not searchable');
});

test('a pressed button filters the page by bucket', async () => {
    calls.length = 0; rows = [];
    await searchAdminStudents({ centralEmail: 'c@example.test', status: 'rejected' });
    const pageCall = calls.find(c => c.sql.includes('SELECT * FROM roster'));
    assert.match(pageCall.sql, /edugate_state = \$2/);
    assert.equal(pageCall.params[1], 'rejected');
});

test('later pages skip the count query', async () => {
    calls.length = 0; rows = [];
    const cursor = Buffer.from('A\u0000B\u00005', 'utf8').toString('base64');
    const page = await searchAdminStudents({ centralEmail: 'c@example.test', cursor });
    assert.equal(page.counts, undefined);
    assert.equal(calls.length, 1);
});

test('filters match the console names', () => {
    assert.deepEqual(ROSTER_FILTERS, ['code_live', 'code_expired', 'registered', 'rejected']);
});

test('the roster spans every college and reports per-college counts', async () => {
    calls.length = 0; rows = [];
    const page = await searchAdminStudents({ centralEmail: 'c@example.test', search: 'ann' });
    assert.deepEqual(page.collegeCounts, { 1: 4, 2: 2, all: 7 }, 'all includes a student with no college');
    const pageCall = calls.find(c => c.sql.includes('SELECT * FROM roster'));
    assert.match(pageCall.sql, /LEFT JOIN colleges c ON c\.id = st\.college_id/);
    assert.match(pageCall.sql, /c\.name AS college_name/);
    assert.doesNotMatch(pageCall.sql, /st\.college_id = /);
    assert.doesNotMatch(pageCall.sql, /deleted_at IS NOT NULL/, 'deleted students are never listed');
    const collegeCall = calls.find(c => c.sql.includes('GROUP BY st.college_id'));
    assert.deepEqual(collegeCall.params, ['c@example.test', '%ann%']);
});

test('a college button narrows the page and status counts, not the college counts', async () => {
    calls.length = 0; rows = [];
    await searchAdminStudents({ centralEmail: 'c@example.test', collegeId: '2', search: 'ann', status: 'registered' });
    const pageCall = calls.find(c => c.sql.includes('SELECT * FROM roster'));
    assert.match(pageCall.sql, /st\.college_id = \$3/);
    assert.deepEqual(pageCall.params.slice(0, 4), ['c@example.test', '%ann%', '2', 'registered']);
    const countCall = calls.find(c => c.sql.includes('count(*) AS "all"'));
    assert.deepEqual(countCall.params, ['c@example.test', '%ann%', '2']);
    const collegeCall = calls.find(c => c.sql.includes('GROUP BY st.college_id'));
    assert.doesNotMatch(collegeCall.sql, /st\.college_id = /);
    assert.deepEqual(collegeCall.params, ['c@example.test', '%ann%']);
});
