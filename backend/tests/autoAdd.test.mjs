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
const { MailboxApiError } = await import('../src/migadu.ts');
const FRIENDLY_MAILBOX = 'The mailbox could not be created right now. Try again; if it keeps failing, tell the owner.';
const FRIENDLY_GENERIC = 'Something went wrong adding this student. Try again; if it keeps failing, tell the owner.';

// Fake Migadu: `taken` = local parts that already exist; `fail` = local parts
// whose creation is refused.
function fakeMigadu({ taken = [], fail = [], details = {} } = {}) {
    const existing = new Set(taken);
    const calls = { created: [], removed: [] };
    return {
        calls,
        domain: 'myemailinfo.com',
        exists: async (local) => existing.has(local),
        // `details[local]` = { name, createdMinutesAgo } for an existing mailbox; by default a taken
        // address belongs to somebody else and was made long ago.
        inspect: async (local) => (existing.has(local) ? (details[local] ?? { name: 'SOMEONE ELSE', createdMinutesAgo: null }) : null),
        create: async (local, name, password) => {
            if (fail.includes(local)) throw new MailboxApiError('Migadu mailbox creation failed (403)');
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
    const migadu = fakeMigadu({ fail: ['neha.joshi', 'neha.joshi1'] });
    const result = await run('NEHA JOSHI,1\nRAJ KUMAR,2', migadu);
    assert.deepEqual(result.rows.map((r) => r.status), ['failed', 'added']);
    assert.equal(result.rows[0].reason, FRIENDLY_MAILBOX);
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
    const result = await run('Student Name,Application No\n,10\nONLY NAME,\nAMIT ROY,11', fakeMigadu());
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

test('Windows line endings and a header in any case work', async () => {
    reset();
    const result = await run('STUDENT NAME,APPLICATION NO\r\nKHAN ALI,21\r\nRAJ KUMAR,22\r\n', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['added', 'added']);
    assert.equal(result.rows[0].email, 'khan.ali@myemailinfo.com');
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

test('a name must be letters and spaces only: digits, dots, hyphens, apostrophes, accents and symbols are refused', async () => {
    reset();
    const migadu = fakeMigadu();
    const bad = ['JANE D0E', "O'BRIEN SEAN", 'MARY-ANNE LEE', 'DR. SMITH', 'RENÉE LEE', '(((', 'AMIT 2ND ROY'];
    const result = await run(bad.map((n, i) => `${n},${i + 1}`).join('\n'), migadu);
    assert.deepEqual(result.rows.map((r) => r.status), bad.map(() => 'failed'));
    assert.ok(result.rows.every((r) => r.reason === 'The name can only have letters (A to Z) and spaces - no numbers, dots, hyphens or other symbols'));
    assert.deepEqual(migadu.calls.created, []);
    assert.equal(state.inserts.length, 0);
});

test('first, middle and last names in upper or lower case are fine, and so is a one-word name', async () => {
    reset();
    const result = await run('Samyak Meshram,1\nZAID KHAN JAKIR KHAN PATHAN,2\niqura,3', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['added', 'added', 'added']);
});

test('a Migadu lookup error fails that line with the error and does not stop the next line', async () => {
    reset();
    const migadu = fakeMigadu();
    let first = true;
    const original = migadu.exists;
    migadu.exists = async (local) => {
        if (first) { first = false; throw new MailboxApiError('Migadu mailbox lookup failed (500)'); }
        return original(local);
    };
    const result = await run('ONE PERSON,1\nTWO PERSON,2', migadu);
    assert.deepEqual(result.rows.map((r) => r.status), ['failed', 'added']);
    assert.equal(result.rows[0].reason, FRIENDLY_MAILBOX);
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

test('the summary counts always add up to the number of lines', async () => {
    reset();
    state.usedAdmission.set('3', 'SOMEONE ELSE');
    const result = await run('A ONE,1\nB TWO,\nC THREE,3\nD FOUR,4', fakeMigadu());
    assert.equal(result.added + result.skipped + result.failed, result.rows.length);
    assert.deepEqual([result.added, result.skipped, result.failed], [2, 1, 1]);
});

test('a comma, with or without spaces around it, separates the name and the Application No', async () => {
    reset();
    const result = await run('ANN ONE,101\nBOB TWO, 102\nCY THREE ,103\nDI FOUR , 104', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['added', 'added', 'added', 'added']);
    assert.deepEqual(result.rows.map((r) => [r.name, r.admissionId]),
        [['ANN ONE', '101'], ['BOB TWO', '102'], ['CY THREE', '103'], ['DI FOUR', '104']]);
});

test('a space or a tab instead of the comma is flagged, and no mailbox is created', async () => {
    reset();
    const migadu = fakeMigadu();
    const result = await run('ANN ONE 101\nBOB TWO\t102\nSAMYAK MESHRAM', migadu);
    assert.deepEqual(result.rows.map((r) => r.status), ['failed', 'failed', 'failed']);
    assert.ok(result.rows.every((r) => r.reason === 'Put a comma between the name and the Application No, like Jane Doe,10012345'));
    assert.deepEqual(migadu.calls.created, []);
    assert.equal(state.inserts.length, 0);
});

test('more than one comma is flagged, including a surname-comma-first-name line', async () => {
    reset();
    const migadu = fakeMigadu();
    const result = await run('KHAN, ALI, 32299\nA,B,C', migadu);
    assert.deepEqual(result.rows.map((r) => r.status), ['failed', 'failed']);
    assert.ok(result.rows.every((r) => r.reason === 'Use only one comma, between the name and the Application No'));
    assert.deepEqual(migadu.calls.created, []);
});

test('a surname-comma-first-name line with the number after it is refused, never a mailbox for the wrong name', async () => {
    reset();
    const migadu = fakeMigadu();
    const result = await run('KHAN, ALI 32299', migadu);
    assert.equal(result.rows[0].status, 'failed');
    assert.match(result.rows[0].reason, /Application No must be a whole number, digits only \(got "ALI 32299"\)/);
    assert.deepEqual(migadu.calls.created, []);
    assert.equal(state.inserts.length, 0);
});

test('an Application No must be a whole positive number: letters, decimals, signs, spaces and zero are refused', async () => {
    reset();
    const migadu = fakeMigadu();
    const bad = ['12AB', 'AB12', '12.5', '-5', '+5', '0', '000', '1 2'];
    const result = await run(bad.map((n, i) => `PERSON ${String.fromCharCode(65 + i)},${n}`).join('\n'), migadu);
    assert.deepEqual(result.rows.map((r) => r.status), bad.map(() => 'failed'));
    assert.ok(result.rows.every((r) => /whole number, digits only/.test(r.reason)));
    assert.deepEqual(migadu.calls.created, []);
    assert.equal(state.inserts.length, 0);
});

test('whole positive numbers are accepted, including ones with leading zeros', async () => {
    reset();
    const result = await run('ONE PERSON,32299\nTWO PERSON,007\nTHREE PERSON,10', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['added', 'added', 'added']);
});

test('the header line is skipped when written with a comma, with or without spaces', async () => {
    reset();
    for (const header of ['Student Name,Application No', 'STUDENT NAME, APPLICATION NO']) {
        const result = await run(`${header}\nAMIT ROY,11`, fakeMigadu());
        assert.equal(result.rows.length, 1, `header "${header}" is skipped`);
    }
});

test('each row keeps the line exactly as it was pasted, so a failed line can be fixed and tried again', async () => {
    reset();
    const result = await run('  ANN ONE 101  \nBOB TWO,102', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.source), ['ANN ONE 101', 'BOB TWO,102']);
});

// Migadu whose look-up says "free", but whose create is refused for the `refuse`
// addresses; with `taken` the refused address exists afterwards (someone else just
// took it - Migadu answers 400 "bad request"). `calls.attempts` lists every create.
function refusingMigadu(refuse, { taken = true } = {}) {
    const api = fakeMigadu();
    const exists = new Set();
    api.calls.attempts = [];
    api.exists = async (local) => exists.has(local);
    api.inspect = async (local) => (exists.has(local) ? { name: 'SOMEONE ELSE', createdMinutesAgo: null } : null);
    api.create = async (local, name, password) => {
        api.calls.attempts.push(local);
        if (refuse.includes(local)) {
            if (taken) exists.add(local);
            throw new MailboxApiError('Migadu mailbox creation failed (400): bad request');
        }
        exists.add(local);
        api.calls.created.push({ local, name, password });
    };
    return api;
}

test('a failed create is not retried inside the same request: one create per line', async () => {
    reset();
    const migadu = refusingMigadu(['new.person']);
    const result = await run('NEW PERSON,5', migadu);
    assert.equal(result.rows[0].status, 'failed');
    assert.equal(result.rows[0].reason, FRIENDLY_MAILBOX);
    assert.deepEqual(migadu.calls.attempts, ['new.person']);
    assert.equal(state.inserts.length, 0);
});

test('the console\'s retry (a new request for the same line) gets the next number when the address was just taken', async () => {
    reset();
    const migadu = refusingMigadu(['new.person']);
    const first = await run('NEW PERSON,5', migadu);
    assert.equal(first.rows[0].status, 'failed');
    const retry = await run('NEW PERSON,5', migadu);
    assert.equal(retry.rows[0].status, 'added');
    assert.equal(retry.rows[0].email, 'new.person1@myemailinfo.com');
    assert.deepEqual(migadu.calls.attempts, ['new.person', 'new.person1']);
});

test('the retry of a line that failed for another reason tries the same address again', async () => {
    reset();
    const migadu = refusingMigadu(['new.person'], { taken: false });
    await run('NEW PERSON,5', migadu);
    const retry = await run('NEW PERSON,5', migadu);
    assert.equal(retry.rows[0].status, 'failed');
    assert.deepEqual(migadu.calls.attempts, ['new.person', 'new.person'], 'same address; only the console decides how many times');
});

test('an address that exists in Migadu but not in our table is skipped, and the result says so', async () => {
    reset();
    const migadu = fakeMigadu({ taken: ['made.byhand'] });
    const result = await run('MADE BYHAND,9', migadu);
    assert.equal(result.rows[0].email, 'made.byhand1@myemailinfo.com');
    assert.match(result.rows[0].reason, /made\.byhand already exists in Migadu but is not in our student list/);
    assert.deepEqual(migadu.calls.created.map((c) => c.local), ['made.byhand1']);
});

test('an address that is in our table (not in Migadu) is skipped with the plain taken note', async () => {
    reset();
    state.dbEmails.add('only.indb@myemailinfo.com');
    const result = await run('ONLY INDB,9', fakeMigadu());
    assert.equal(result.rows[0].email, 'only.indb1@myemailinfo.com');
    assert.match(result.rows[0].reason, /only\.indb was taken, so a number was added/);
    assert.doesNotMatch(result.rows[0].reason, /Migadu/);
});

test('four- and five-word names use the first and last word for the address', async () => {
    reset();
    const result = await run('Bankim chandar das chatterjee,1\nANNA MARIA LOUISE VAN DER BERG,2', fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['added', 'added']);
    assert.deepEqual(result.rows.map((r) => r.email), ['bankim.chatterjee@myemailinfo.com', 'anna.berg@myemailinfo.com']);
    assert.equal(result.rows[0].name, 'Bankim chandar das chatterjee');
});

test('spaces before the name, around the comma and after the number, and any line ending, are tidied', async () => {
    reset();
    const csv = '  JANE   DOE  ,  101  \r\nJOHN ROE ,102\nANN LEE, 103 \rBOB TWO,104';
    const result = await run(csv, fakeMigadu());
    assert.deepEqual(result.rows.map((r) => r.status), ['added', 'added', 'added', 'added']);
    assert.deepEqual(result.rows.map((r) => [r.name, r.admissionId]),
        [['JANE DOE', '101'], ['JOHN ROE', '102'], ['ANN LEE', '103'], ['BOB TWO', '104']]);
    assert.deepEqual(result.rows.map((r) => r.line), [1, 2, 3, 4]);
});

test('a name in quotes with a comma inside has two commas and is refused', async () => {
    reset();
    const migadu = fakeMigadu();
    const result = await run('"KHAN, ALI",21', migadu);
    assert.equal(result.rows[0].status, 'failed');
    assert.equal(result.rows[0].reason, 'Use only one comma, between the name and the Application No');
    assert.deepEqual(migadu.calls.created, []);
});

test('the screen never gets technical text: no Migadu message, status code or exception detail in a failed row', async () => {
    reset();
    const migadu = fakeMigadu({ fail: ['one.person', 'one.person1'] });
    const result = await run('ONE PERSON,1', migadu);
    assert.doesNotMatch(result.rows[0].reason, /Migadu|403|400|Error/);
});

test('a failure that is not from Migadu gets the generic friendly message', async () => {
    reset();
    const migadu = fakeMigadu();
    migadu.exists = async () => { throw new TypeError('something unexpected'); };
    const result = await run('ONE PERSON,1', migadu);
    assert.equal(result.rows[0].reason, FRIENDLY_GENERIC);
    assert.doesNotMatch(result.rows[0].reason, /unexpected/);
});

// ---- audit trail: [audit] lines in the server log, never with a password
async function captureAudit(fn) {
    const lines = [];
    const original = console.log;
    console.log = (...args) => { const text = args.join(' '); if (text.startsWith('[audit] ')) lines.push(JSON.parse(text.slice(8))); else original(...args); };
    try { await fn(); } finally { console.log = original; }
    return lines;
}

test('every line gets an audit entry with who (central, college, IP), what and the outcome', async () => {
    reset();
    state.usedAdmission.set('30437', 'ZUNAIRA SAQI');
    const migadu = fakeMigadu({ fail: ['neha.joshi', 'neha.joshi1'] });
    const entries = await captureAudit(() => autoAddStudents(
        'SAMYAK MESHRAM,32299\nARJUN VERMA,30437\nNEHA JOSHI,32305', 'central@example.test', '3', 'IHSM ELITE', migadu, '203.0.113.9'));
    const lines = entries.filter((e) => e.event === 'student-add');
    assert.deepEqual(lines.map((e) => [e.line, e.outcome, e.applicationNo, e.email]), [
        [1, 'added', '32299', 'samyak.meshram@myemailinfo.com'],
        [2, 'skipped', '30437', null],
        [3, 'failed', '32305', null],
    ]);
    assert.ok(lines.every((e) => e.central === 'central@example.test' && e.college === 'IHSM ELITE' && e.ip === '203.0.113.9' && e.at));
    assert.match(lines[1].reason, /already used by ZUNAIRA SAQI/);
    assert.deepEqual(entries.filter((e) => e.event === 'mailbox-created').map((e) => e.email), ['samyak.meshram@myemailinfo.com']);
});

test('a mailbox removed after a failed save is audited, and nothing audited contains a password', async () => {
    reset();
    state.failInsert = true;
    const migadu = fakeMigadu();
    const entries = await captureAudit(() => autoAddStudents('RAJ KUMAR,2', 'central@example.test', '3', 'IHSM ELITE', migadu, '198.51.100.7'));
    assert.deepEqual(entries.map((e) => e.event), ['mailbox-created', 'mailbox-removed', 'student-add']);
    assert.equal(entries[2].outcome, 'failed');
    assert.ok(entries.every((e) => !JSON.stringify(e).toLowerCase().includes('password')));
});

// ---- a mailbox made by this add's own earlier try (reply lost) is adopted, not duplicated
test('a mailbox with this student\'s name, made a few minutes ago and not in our table, is adopted: no second mailbox', async () => {
    reset();
    const migadu = fakeMigadu({ taken: ['samyak.meshram'], details: { 'samyak.meshram': { name: 'SAMYAK MESHRAM', createdMinutesAgo: 2 } } });
    let result;
    const entries = await captureAudit(async () => { result = await run('SAMYAK MESHRAM,32299', migadu); });
    assert.equal(result.rows[0].status, 'added');
    assert.equal(result.rows[0].email, 'samyak.meshram@myemailinfo.com', 'the same address, not samyak.meshram1');
    assert.match(result.rows[0].reason, /earlier try/);
    assert.deepEqual(migadu.calls.created, [], 'nothing new was created in Migadu');
    assert.equal(state.inserts[0][3], 'samyak.meshram@myemailinfo.com');
    assert.deepEqual(entries.filter((e) => e.event !== 'student-add').map((e) => e.event), ['mailbox-adopted']);
});

test('a mailbox with a different name, or made long ago, or of unknown age, is not adopted: the next number is used', async () => {
    reset();
    const cases = [
        { name: 'SOMEONE ELSE', createdMinutesAgo: 1 },
        { name: 'SAMYAK MESHRAM', createdMinutesAgo: 11 },
        { name: 'SAMYAK MESHRAM', createdMinutesAgo: null },
    ];
    for (const info of cases) {
        const migadu = fakeMigadu({ taken: ['samyak.meshram'], details: { 'samyak.meshram': info } });
        const result = await run('SAMYAK MESHRAM,32299', migadu);
        assert.equal(result.rows[0].email, 'samyak.meshram1@myemailinfo.com', JSON.stringify(info));
        assert.deepEqual(migadu.calls.created.map((c) => c.local), ['samyak.meshram1']);
    }
});

test('adoption needs the same name ignoring case and exactly 10 minutes or less', async () => {
    reset();
    const ok = fakeMigadu({ taken: ['sam.lee'], details: { 'sam.lee': { name: 'sam lee', createdMinutesAgo: 10 } } });
    assert.equal((await run('SAM LEE,1', ok)).rows[0].email, 'sam.lee@myemailinfo.com');
});

test('an address that is already in our students table is never adopted, even if it looks like a match', async () => {
    reset();
    state.dbEmails.add('samyak.meshram@myemailinfo.com');
    const migadu = fakeMigadu({ taken: ['samyak.meshram'], details: { 'samyak.meshram': { name: 'SAMYAK MESHRAM', createdMinutesAgo: 1 } } });
    const result = await run('SAMYAK MESHRAM,32299', migadu);
    assert.equal(result.rows[0].email, 'samyak.meshram1@myemailinfo.com');
});

test('if saving fails for an adopted mailbox, it is left in place (not removed) and the line fails', async () => {
    reset();
    state.failInsert = true;
    const migadu = fakeMigadu({ taken: ['sam.lee'], details: { 'sam.lee': { name: 'SAM LEE', createdMinutesAgo: 1 } } });
    const result = await run('SAM LEE,1', migadu);
    assert.equal(result.rows[0].status, 'failed');
    assert.deepEqual(migadu.calls.removed, []);
});
