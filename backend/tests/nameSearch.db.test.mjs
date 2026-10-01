// Student search by name words (console search and Students dialog): every
// typed word must match, in any order, partially, ignoring case.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, builders } from './helpers/testdb.mjs';

const t = await startTestDb();
const skip = t ? false : 'no PostgreSQL server binaries available';
after(() => t?.stop());

let thread, roster, b;
if (t) {
    mock.module('../src/db.ts', { exports: { db: t.pool } });
    thread = await import('../src/thread.ts');
    roster = await import('../src/studentsAdmin.ts');
    b = builders(t.pool);
}

const CENTRAL = 'central@example.test';

beforeEach(async () => {
    if (t) await t.reset();
});

// The same search through all three queries; each returns the matching emails.
const viaDialog = async (search) =>
    (await roster.searchAdminStudents({ centralEmail: CENTRAL, search })).students.map((s) => s.email).sort();
const viaMatches = async (search) =>
    (await thread.findSearchMatches(search, '1', 50)).students.map((s) => s.email).sort();
const searches = { dialog: viaDialog, matches: viaMatches };

async function seed() {
    const farman = await b.student({ first: 'MOHD FARMAN', last: 'KHAN', admission: 'A_102' });
    const other = await b.student({ first: 'MOHD ASIF', last: 'ALI', admission: 'B200' });
    const third = await b.student({ first: 'RIYA', last: 'KHAN', admission: 'C300' });
    return { farman, other, third };
}

for (const [name, run] of Object.entries(searches)) {
    for (const query of ['MOHD FARMAN KHAN', 'MOHD KHAN', 'FARMAN MOHD KHAN', 'khan farman mohd', 'farman mohd khan', 'farma moh kha', '  MOHD   KHAN  ']) {
        test(`${name}: "${query}" finds the student`, { skip }, async () => {
            const { farman } = await seed();
            assert.deepEqual(await run(query), [farman]);
        });
    }

    test(`${name}: one word still matches every student with it`, { skip }, async () => {
        const { farman, third } = await seed();
        assert.deepEqual(await run('khan'), [farman, third].sort());
    });

    test(`${name}: a word that matches nobody returns nothing`, { skip }, async () => {
        await seed();
        assert.deepEqual(await run('MOHD ZZZ'), []);
    });

    test(`${name}: email and admission ID searches still work`, { skip }, async () => {
        const { farman } = await seed();
        assert.deepEqual(await run(farman.toUpperCase()), [farman]);
        assert.deepEqual(await run('a_102'), [farman]);
    });

    test(`${name}: name mixed with email or admission ID, in any order`, { skip }, async () => {
        const { farman, third } = await seed();
        assert.deepEqual(await run(`khan ${farman}`), [farman]);
        assert.deepEqual(await run(`${farman} MOHD farma`), [farman]);
        assert.deepEqual(await run('KHAN a_102'), [farman]);
        assert.deepEqual(await run('a_102 farman khan'), [farman]);
        assert.deepEqual(await run('khan c300'), [third]);
        assert.deepEqual(await run(`riya ${farman}`), []);
        assert.deepEqual(await run('farman c300'), []);
    });

    test(`${name}: % and _ are matched literally`, { skip }, async () => {
        const { farman } = await seed();
        assert.deepEqual(await run('%'), []);
        assert.deepEqual(await run('A_102 khan'), [farman]);
        assert.deepEqual(await run('A_1_2'), []);
    });
}

test('a very long search is capped and still answers fast', { skip }, async () => {
    await seed();
    const many = Array.from({ length: 5000 }, () => 'khan').join(' ');
    const started = Date.now();
    assert.deepEqual(await viaDialog(many), await viaDialog('khan'));
    assert.ok(Date.now() - started < 2000);
    assert.equal((await thread.findSearchMatches(many, '1', 50)).tooMany, false);
});

test('blank search text still builds a valid query', { skip }, async () => {
    await seed();
    assert.equal((await thread.findSearchMatches('   ', '1', 50)).students.length, 3);
});

test('dialog: counts and paging follow the multi-word search', { skip }, async () => {
    await seed();
    const page = await roster.searchAdminStudents({ centralEmail: CENTRAL, search: 'khan mohd' });
    assert.equal(page.students.length, 1);
    assert.equal(page.counts.all, 1);
});

test('console list: a multi-word search finds the student\'s mail', { skip }, async () => {
    const { farman, other } = await seed();
    await b.message({ student: farman, subject: 'for farman' });
    await b.message({ student: other, subject: 'for asif' });
    const list = await thread.fetchThreadSummaries('all', CENTRAL, '1', 25, 0, 'khan MOHD');
    const rows = list.threads;
    assert.deepEqual(rows.map((r) => r.subject), ['for farman']);
});
