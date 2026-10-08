// Which Application Nos are already used in a college (usedApplicationNumbers in
// src/students.ts, behind POST /api/students/check-numbers), against a real,
// throwaway PostgreSQL: scoped to one college, deleted students count, the answer
// carries the owner's name, and it is one query for the whole box.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, builders } from './helpers/testdb.mjs';

const t = await startTestDb();
const skip = t ? false : 'no PostgreSQL server binaries available';
after(() => t?.stop());

let students, b;
if (t) {
    mock.module('../src/db.ts', { exports: { db: t.pool } });
    students = await import('../src/students.ts');
    b = builders(t.pool);
}

beforeEach(async () => {
    if (t) await t.reset();
});

test('numbers used by a student of the college come back with that student\'s name', { skip }, async () => {
    await b.student({ first: 'Zunaira', last: 'Saqi', college: 1, admission: '30437' });
    await b.student({ first: 'Rajat', last: 'Roy', college: 1, admission: '32212' });
    const used = await students.usedApplicationNumbers('1', ['30437', '32212', '99999']);
    assert.deepEqual(used, { 30437: { name: 'Zunaira Saqi', deleted: false }, 32212: { name: 'Rajat Roy', deleted: false } });
});

test('only this college is looked at: the same number in another college is free', { skip }, async () => {
    await b.college('Other College');
    await b.student({ college: 2, admission: '555' });
    assert.deepEqual(await students.usedApplicationNumbers('1', ['555']), {});
    assert.equal(Object.keys(await students.usedApplicationNumbers('2', ['555'])).length, 1);
});

test('a deleted student\'s number counts as used and says so', { skip }, async () => {
    await b.student({ first: 'Old', last: 'Student', college: 1, admission: '777', deleted: true });
    assert.deepEqual(await students.usedApplicationNumbers('1', ['777']), { 777: { name: 'Old Student', deleted: true } });
});

test('nothing asked, nothing returned; repeats are asked once; the list is capped', { skip }, async () => {
    assert.deepEqual(await students.usedApplicationNumbers('1', []), {});
    await b.student({ college: 1, admission: '5' });
    assert.equal(Object.keys(await students.usedApplicationNumbers('1', ['5', '5', '5'])).length, 1);
    const many = Array.from({ length: students.MAX_NUMBERS_TO_CHECK + 10 }, (_, i) => String(i + 1));
    await b.student({ college: 1, admission: String(students.MAX_NUMBERS_TO_CHECK + 5) });
    assert.deepEqual(await students.usedApplicationNumbers('1', many), { 5: { name: 'Ann Lee', deleted: false } }, 'numbers past the cap are not looked at');
});
