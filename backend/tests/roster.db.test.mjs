// The Students dialog roster (searchAdminStudents) against real SQL: every
// college with a College column, the college and status buttons with their
// counts, search, paging, and who may see whom.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, builders } from './helpers/testdb.mjs';

const t = await startTestDb();
const skip = t ? false : 'no PostgreSQL server binaries available';
after(() => t?.stop());

let roster, b;
if (t) {
    mock.module('../src/db.ts', { exports: { db: t.pool } });
    roster = await import('../src/studentsAdmin.ts');
    b = builders(t.pool);
}

const CENTRAL = 'central@example.test';
const minutesAgo = (m) => new Date(Date.now() - m * 60000);
const find = (opts = {}) => roster.searchAdminStudents({ centralEmail: CENTRAL, ...opts });
const emails = (page) => page.students.map((s) => s.email);

// Sets a student's Edugate columns the way the mail sync does.
const setEdugate = (email, { code = null, login = null, rejected = null } = {}) =>
    t.pool.query('UPDATE students SET code_sent_at = $2, registered_at = $3, rejected_at = $4 WHERE email = $1', [email, code, login, rejected]);

beforeEach(async () => {
    if (t) await t.reset();
});

test('the roster spans every college and names each student\'s college', { skip }, async () => {
    const a = await b.student({ college: 1, first: 'Ann' });
    const c = await b.student({ college: 2, first: 'Bea' });
    const d = await b.student({ college: 3, first: 'Cy' });
    const page = await find();
    assert.deepEqual(emails(page), [a, c, d]);
    assert.deepEqual(page.students.map((s) => s.college_name), ['KSMA CENTRAL', 'IHSM CENTRAL', 'IHSM ELITE']);
    assert.deepEqual(page.students.map((s) => String(s.college_id)), ['1', '2', '3']);
});

test('a college button narrows the list to that college', { skip }, async () => {
    await b.student({ college: 1 });
    const two = await b.student({ college: 2 });
    await b.student({ college: 3 });
    assert.deepEqual(emails(await find({ collegeId: '2' })), [two]);
    assert.deepEqual(emails(await find({ collegeId: '99' })), []);
});

test('college counts cover the whole search, whichever college is pressed', { skip }, async () => {
    await b.student({ college: 1, first: 'Ann' });
    await b.student({ college: 1, first: 'Ann' });
    await b.student({ college: 2, first: 'Ann' });
    await b.student({ college: 3, first: 'Other' });
    const everyone = await find();
    assert.deepEqual(everyone.collegeCounts, { 1: 2, 2: 1, 3: 1, all: 4 });
    const searched = await find({ search: 'ann', collegeId: '1' });
    assert.deepEqual(searched.collegeCounts, { 1: 2, 2: 1, all: 3 }, 'the search narrows the counts; the pressed college does not');
    assert.equal(searched.counts.all, 2, 'but the status counts follow the pressed college');
});

test('a student with no college is in "all" but in no college button', { skip }, async () => {
    await b.student({ college: 1 });
    await b.student({ college: null });
    const page = await find();
    assert.equal(page.collegeCounts.all, 2);
    assert.equal(page.collegeCounts[1], 1);
    assert.equal(Object.keys(page.collegeCounts).length, 2, 'only college 1 and "all"');
    const noCollege = page.students.find((s) => s.college_id === null);
    assert.equal(noCollege.college_name, null);
});

test('only this operator\'s mailbox and active students are listed', { skip }, async () => {
    const mine = await b.student();
    await b.student({ central: 'other@example.test' });
    await b.student({ deleted: true });
    assert.deepEqual(emails(await find()), [mine]);
    assert.equal((await find()).collegeCounts.all, 1);
});

test('each status bucket follows the student\'s latest Edugate event', { skip }, async () => {
    const none = await b.student({ first: 'A' });
    const live = await b.student({ first: 'B' });
    const expired = await b.student({ first: 'C' });
    const registered = await b.student({ first: 'D' });
    const rejected = await b.student({ first: 'E' });
    await setEdugate(live, { code: minutesAgo(5) });
    await setEdugate(expired, { code: minutesAgo(90) });
    await setEdugate(registered, { code: minutesAgo(200), login: minutesAgo(180) });
    await setEdugate(rejected, { login: minutesAgo(300), rejected: minutesAgo(30) });
    const page = await find();
    const state = Object.fromEntries(page.students.map((s) => [s.email, s.edugate_state]));
    assert.deepEqual(state, { [none]: null, [live]: 'code_live', [expired]: 'code_expired', [registered]: 'registered', [rejected]: 'rejected' });
    assert.deepEqual(page.counts, { all: 5, code_live: 1, code_expired: 1, registered: 1, rejected: 1 });
});

test('a code requested after a rejection puts the student back under the code buttons', { skip }, async () => {
    const s = await b.student();
    await setEdugate(s, { rejected: minutesAgo(200), code: minutesAgo(10) });
    assert.equal((await find()).students[0].edugate_state, 'code_live');
});

test('a rejection older than the registration leaves the student registered', { skip }, async () => {
    const s = await b.student();
    await setEdugate(s, { rejected: minutesAgo(500), login: minutesAgo(100), code: minutesAgo(200) });
    assert.equal((await find()).students[0].edugate_state, 'registered');
});

test('a code becomes expired after 30 minutes', { skip }, async () => {
    const a = await b.student({ first: 'A' });
    const c = await b.student({ first: 'C' });
    await setEdugate(a, { code: minutesAgo(29) });
    await setEdugate(c, { code: minutesAgo(31) });
    const state = Object.fromEntries((await find()).students.map((s) => [s.email, s.edugate_state]));
    assert.deepEqual([state[a], state[c]], ['code_live', 'code_expired']);
});

test('a status button lists only that bucket, and its count matches', { skip }, async () => {
    const live = await b.student({ first: 'B' });
    const reg = await b.student({ first: 'D' });
    await setEdugate(live, { code: minutesAgo(5) });
    await setEdugate(reg, { login: minutesAgo(60) });

    for (const [status, want] of [['code_live', [live]], ['registered', [reg]], ['rejected', []], ['code_expired', []]]) {
        const page = await find({ status });
        assert.deepEqual(emails(page), want, status);
        assert.equal(page.counts[status], want.length, status);
    }
});

test('college and status buttons combine', { skip }, async () => {
    const a = await b.student({ college: 1, first: 'A' });
    const c = await b.student({ college: 2, first: 'C' });
    await setEdugate(a, { login: minutesAgo(60) });
    await setEdugate(c, { login: minutesAgo(60) });
    assert.deepEqual(emails(await find({ collegeId: '2', status: 'registered' })), [c]);
    assert.deepEqual(emails(await find({ collegeId: '2', status: 'code_live' })), []);
});

test('the roster is ordered by first name, then last name, then id', { skip }, async () => {
    const z = await b.student({ first: 'Zed', last: 'A' });
    const m2 = await b.student({ first: 'Mia', last: 'B' });
    const m1 = await b.student({ first: 'Mia', last: 'A' });
    const dup1 = await b.student({ first: 'Mia', last: 'A' });
    const a = await b.student({ first: 'Abe', last: 'Z' });
    assert.deepEqual(emails(await find()), [a, m1, dup1, m2, z]);
});

test('paging with the cursor visits everyone once, even with identical names', { skip }, async () => {
    for (let i = 0; i < 23; i++) await b.student({ first: i < 12 ? 'Same' : `N${i}`, last: 'Name' });
    const seen = [];
    let cursor = null;
    let pages = 0;

    do {
        const page = await find({ cursor, limit: 5 });
        seen.push(...emails(page));
        cursor = page.nextCursor;
        pages++;
        assert.ok(pages < 20, 'terminates');
    } while (cursor);

    assert.equal(seen.length, 23);
    assert.equal(new Set(seen).size, 23);
    assert.equal(pages, 5);
});

test('only the first page carries counts', { skip }, async () => {
    for (let i = 0; i < 4; i++) await b.student({ first: `N${i}` });
    const first = await find({ limit: 2 });
    assert.ok(first.counts && first.collegeCounts);
    assert.ok(first.nextCursor);
    const second = await find({ limit: 2, cursor: first.nextCursor });
    assert.equal(second.counts, undefined);
    assert.equal(second.collegeCounts, undefined);
    assert.equal(second.nextCursor, null);
});

test('the page size is kept within 1 and 100', { skip }, async () => {
    for (let i = 0; i < 3; i++) await b.student({ first: `N${i}` });
    assert.equal((await find({ limit: 0 })).students.length, 1);
    assert.equal((await find({ limit: -5 })).students.length, 1);
    assert.equal((await find({ limit: 100000 })).students.length, 3);
});

test('a cursor that cannot be read starts from the top', { skip }, async () => {
    const a = await b.student({ first: 'Ann' });
    assert.deepEqual(emails(await find({ cursor: 'not-a-cursor' })), [a]);
    const noNumber = Buffer.from('a\u0000b\u0000nope', 'utf8').toString('base64');
    assert.deepEqual(emails(await find({ cursor: noNumber })), [a]);
});

test('search finds name, email, application number and mailbox, ignoring case', { skip }, async () => {
    const s = await b.student({ first: 'Zainab', last: 'Karimova', email: 'zk@example.test', admission: '7654321' });
    await b.student({ first: 'Other', last: 'Person' });

    for (const q of ['zainab', 'KARIMOVA', 'zk@example', '7654321', 'zainab karimova']) {
        assert.deepEqual(emails(await find({ search: q })), [s], q);
    }

    assert.equal((await find({ search: 'central@example' })).students.length, 2, 'the mailbox is searchable too');
    assert.equal((await find({ search: 'nobody' })).students.length, 0);
});

test('the enrolment year is not searchable', { skip }, async () => {
    await b.student();
    assert.equal((await find({ search: '2026' })).students.length, 0);
    assert.equal((await find({ search: '20' })).students.length, 0);
    assert.equal((await find()).students[0].year_enrolled, 2026, 'but it is still shown');
});

test('a search narrows the status counts too', { skip }, async () => {
    const a = await b.student({ first: 'Findme' });
    const c = await b.student({ first: 'Other' });
    await setEdugate(a, { login: minutesAgo(60) });
    await setEdugate(c, { login: minutesAgo(60) });
    const page = await find({ search: 'findme' });
    assert.deepEqual(page.counts, { all: 1, code_live: 0, code_expired: 0, registered: 1, rejected: 0 });
});

test('the roster never reads the messages table', { skip }, async () => {
    for (let i = 0; i < 30; i++) await b.student({ first: `N${i}` });
    const seen = [];
    const original = t.pool.query.bind(t.pool);
    t.pool.query = (...args) => {
        seen.push(String(args[0]));
        return original(...args);
    };

    try {
        await find();
        await find({ collegeId: '1', status: 'registered' });
    } finally {
        t.pool.query = original;
    }

    assert.ok(seen.length >= 4);
    for (const sql of seen) assert.doesNotMatch(sql, /FROM\s+messages/i);
});
