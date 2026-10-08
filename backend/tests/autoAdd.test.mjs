// "Add students" from Student Name,Application No: the email-address rule and
// the per-line flow (Migadu mailbox first, then the student record), against a
// fake database and a fake Migadu.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Fake database. `usedAdmission` = Application Nos already in the college,
// `dbEmails` = emails already in students, `failInsert` makes the INSERT throw.
const state = { usedAdmission: new Map(), dbEmails: new Set(), failInsert: false, inserts: [] };
mock.module('../src/db.ts', { exports: { db: { query: async (sql, params) => {
    if (sql.includes('FROM students WHERE college_id')) {
        const name = state.usedAdmission.get(params[1]);
        return name === undefined ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ name }] };
    }
    if (sql.includes('FROM students WHERE email')) {
        return { rowCount: state.dbEmails.has(params[0]) ? 1 : 0, rows: [] };
    }
    if (sql.includes('INSERT INTO students')) {
        if (state.failInsert) throw new Error('insert failed');
        state.inserts.push(params);
        return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
} } } });

const { emailBase, emailCandidates } = await import('../src/studentEmail.ts');
const { autoAddStudents, AutoAddInputError, AUTO_ADD_MAX_ROWS } = await import('../src/autoAdd.ts');

// Fake Migadu: `taken` = local parts that already exist; `fail` = local parts
// whose creation is refused.
function fakeMigadu({ taken = [], fail = [] } = {}) {
    const existing = new Set(taken);
    const calls = { created: [], removed: [] };
    return {
        calls,
        domain: 'myemailinfo.com',
        exists: async (local) => existing.has(local),
        create: async (local, name, password) => {
            if (fail.includes(local)) throw new Error('Migadu mailbox creation failed (403)');
            existing.add(local);
            calls.created.push({ local, name, password });
        },
        remove: async (local) => { existing.delete(local); calls.removed.push(local); },
    };
}

const reset = () => { state.usedAdmission = new Map(); state.dbEmails = new Set(); state.failInsert = false; state.inserts = []; };
const run = (csv, migadu) => autoAddStudents(csv, 'central@example.test', '3', 'IHSM ELITE', migadu);

test('address rule: first word + last word, lowercase, plain letters', () => {
    assert.equal(emailBase('SAMYAK MESHRAM'), 'samyak.meshram');
    assert.equal(emailBase('ZAID KHAN JAKIR KHAN PATHAN'), 'zaid.pathan');
    assert.equal(emailBase('IQURA'), 'iqura');
    assert.equal(emailBase("  Renée   O'Brien-Smith "), 'renee.obriensmith');
    assert.equal(emailBase('Aarav 2nd Shah'), 'aarav.shah');
    assert.equal(emailBase('(( ))'), null);
});

test('candidates are the base, then the base with 1, 2, 3 after it', () => {
    assert.deepEqual([...emailCandidates('priya.sharma', 4)], ['priya.sharma', 'priya.sharma1', 'priya.sharma2', 'priya.sharma3']);
});

test('a new student gets a mailbox, then a record with the fixed values', async () => {
    reset();
    const migadu = fakeMigadu();
    const result = await run('Student Name,Application No\nSAMYAK MESHRAM,32299', migadu);
    assert.deepEqual([result.added, result.skipped, result.failed], [1, 0, 0]);
    assert.equal(result.rows[0].email, 'samyak.meshram@myemailinfo.com');
    assert.deepEqual(migadu.calls.created, [{ local: 'samyak.meshram', name: 'SAMYAK MESHRAM', password: 'password' }]);
    const [name, first, last, email, password, central, college, collegeId, admission, year, ...rest] = state.inserts[0];
    assert.deepEqual([name, first, last, email, password, central, college, collegeId, admission, year],
        ['SAMYAK MESHRAM', 'SAMYAK', 'MESHRAM', 'samyak.meshram@myemailinfo.com', 'password', 'central@example.test', 'IHSM ELITE', '3', '32299', new Date().getUTCFullYear()]);
    assert.deepEqual(rest, []);
});

test('a taken address (in Migadu or in our table) gets a number after the name', async () => {
    reset();
    state.dbEmails.add('priya.sharma1@myemailinfo.com');
    const migadu = fakeMigadu({ taken: ['priya.sharma'] });
    const result = await run('PRIYA SHARMA,1\nPRIYA SHARMA,2', migadu);
    assert.deepEqual(result.rows.map((r) => r.email), ['priya.sharma2@myemailinfo.com', 'priya.sharma3@myemailinfo.com']);
    assert.match(result.rows[0].reason, /number was added/);
});

test('an Application No already used in the college is skipped, no mailbox made', async () => {
    reset();
    state.usedAdmission.set('30437', 'ZUNAIRA SAQI');
    const migadu = fakeMigadu();
    const result = await run('ARJUN VERMA,30437', migadu);
    assert.equal(result.skipped, 1);
    assert.match(result.rows[0].reason, /already used by ZUNAIRA SAQI/);
    assert.deepEqual(migadu.calls.created, []);
    assert.equal(state.inserts.length, 0);
});

test('the same Application No twice in one paste: the later line is skipped', async () => {
    reset();
    const result = await run('A ONE,500\nB TWO,500', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['added', 'skipped']);
    assert.match(result.rows[1].reason, /also on line 1/);
});

test('Migadu refusing a mailbox fails only that line and saves nothing for it', async () => {
    reset();
    const migadu = fakeMigadu({ fail: ['neha.joshi'] });
    const result = await run('NEHA JOSHI,1\nRAJ KUMAR,2', migadu);
    assert.deepEqual(result.rows.map((r) => r.status), ['failed', 'added']);
    assert.match(result.rows[0].reason, /Migadu mailbox creation failed/);
    assert.equal(result.rows[0].email, null);
    assert.equal(state.inserts.length, 1);
});

test('if saving fails after the mailbox was made, the mailbox is removed again', async () => {
    reset();
    state.failInsert = true;
    const migadu = fakeMigadu();
    const result = await run('RAJ KUMAR,2', migadu);
    assert.equal(result.failed, 1);
    assert.deepEqual(migadu.calls.removed, ['raj.kumar']);
    assert.match(result.rows[0].reason, /mailbox was removed/);
});

test('missing name or Application No fails that line; the header is optional', async () => {
    reset();
    const result = await run('Student Name,Application No\n,10\nONLY NAME\nAMIT ROY,11', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['failed', 'failed', 'added']);
    assert.equal(result.rows[0].reason, 'Missing student name');
    assert.equal(result.rows[1].reason, 'Missing Application No');
});

test('empty input and too many lines are rejected up front', async () => {
    reset();
    await assert.rejects(run('Student Name,Application No\n', fakeMigadu()), AutoAddInputError);
    const many = Array.from({ length: AUTO_ADD_MAX_ROWS + 1 }, (_, i) => `NAME ${i},${i}`).join('\n');
    await assert.rejects(run(many, fakeMigadu()), AutoAddInputError);
});

test('Windows line endings, a quoted name with a comma, and a header in any case all work', async () => {
    reset();
    const result = await run('STUDENT NAME,APPLICATION NO\r\n"KHAN, ALI",21\r\nRAJ KUMAR,22\r\n', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['added', 'added']);
    assert.equal(result.rows[0].name, 'KHAN, ALI');
    assert.equal(result.rows[0].email, 'khan.ali@myemailinfo.com', 'the comma is dropped from the address');
    assert.deepEqual(result.rows.map((r) => r.line), [2, 3], 'line numbers count the header');
});

test('extra spaces in a name are tidied before it is saved and sent to Migadu', async () => {
    reset();
    const migadu = fakeMigadu();
    await run('  AMIT    KUMAR   ROY  ,  11  ', migadu);
    assert.equal(migadu.calls.created[0].name, 'AMIT KUMAR ROY');
    assert.equal(migadu.calls.created[0].local, 'amit.roy');
    assert.equal(state.inserts[0][8], '11', 'the Application No is trimmed');
});

test('a name with no letters fails that line without calling Migadu', async () => {
    reset();
    const migadu = fakeMigadu();
    const result = await run('(((),5', migadu);
    assert.equal(result.failed, 1);
    assert.match(result.rows[0].reason, /no letters/);
    assert.deepEqual(migadu.calls.created, []);
});

test('a Migadu lookup error fails that line with the error and does not stop the next line', async () => {
    reset();
    const migadu = fakeMigadu();
    let first = true;
    const original = migadu.exists;
    migadu.exists = async (local) => {
        if (first) { first = false; throw new Error('Migadu mailbox lookup failed (500)'); }
        return original(local);
    };
    const result = await run('ONE PERSON,1\nTWO PERSON,2', migadu);
    assert.deepEqual(result.rows.map((r) => r.status), ['failed', 'added']);
    assert.match(result.rows[0].reason, /lookup failed/);
    assert.equal(state.inserts.length, 1);
});

test('when every candidate address is taken the line fails and nothing is created', async () => {
    reset();
    const taken = ['full.name', ...Array.from({ length: 49 }, (_, i) => `full.name${i + 1}`)];
    const migadu = fakeMigadu({ taken });
    const result = await run('FULL NAME,7', migadu);
    assert.equal(result.failed, 1);
    assert.match(result.rows[0].reason, /No free address/);
    assert.deepEqual(migadu.calls.created, []);
});

test('a failed mailbox removal after a failed save does not hide the failure', async () => {
    reset();
    state.failInsert = true;
    const migadu = fakeMigadu();
    migadu.remove = async () => { throw new Error('Migadu mailbox removal failed (500)'); };
    const result = await run('RAJ KUMAR,2', migadu);
    assert.equal(result.failed, 1);
    assert.equal(result.rows[0].email, null);
});

test('an address freed by a failed line can be used by the next line', async () => {
    reset();
    const migadu = fakeMigadu({ fail: ['sam.lee'] });
    const result = await run('SAM LEE,1\nSAM LEE,2', migadu);
    assert.deepEqual(result.rows.map((r) => r.status), ['failed', 'failed']);
    const migadu2 = fakeMigadu();
    const ok = await run('SAM LEE,1\nSAM LEE,2', migadu2);
    assert.deepEqual(ok.rows.map((r) => r.email), ['sam.lee@myemailinfo.com', 'sam.lee1@myemailinfo.com']);
});

test('the summary counts always add up to the number of lines', async () => {
    reset();
    state.usedAdmission.set('3', 'SOMEONE ELSE');
    const result = await run('A ONE,1\nB TWO,\nC THREE,3\nD FOUR,4', fakeMigadu());
    assert.equal(result.added + result.skipped + result.failed, result.rows.length);
    assert.deepEqual([result.added, result.skipped, result.failed], [2, 1, 1]);
});
