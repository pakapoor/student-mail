// The Add students box checks what was typed before anything is sent
// (frontend/src/studentLines.ts), and the Add button stays off while it reports
// a problem. The server applies the same rules (backend/src/autoAdd.ts); the
// parity test below fails if the two ever disagree.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { checkStudentLines, MAX_STUDENT_LINES } from '../../frontend/src/studentLines.ts';

const messages = (text) => checkStudentLines(text).errors.map((e) => `${e.line}:${e.message}`);

test('an empty box has nothing to flag and nothing to add', () => {
    assert.deepEqual(checkStudentLines(''), { errors: [], count: 0, lines: [] });
    assert.deepEqual(checkStudentLines('  \n \n'), { errors: [], count: 0, lines: [] });
});

test('good lines pass, with or without spaces around the comma and with a header', () => {
    const check = checkStudentLines('Student Name,Application No\nJane Doe,10012345\nJohn Roe , 10012346\nAnna Lee,20');
    assert.deepEqual(check.errors, []);
    assert.equal(check.count, 3, 'the header is not counted');
});

test('a space or a tab instead of the comma is flagged with the line number', () => {
    assert.deepEqual(messages('Jane Doe,1\nJohn Roe 2\nAnn Lee\t3'), [
        '2:Put a comma between the name and the Application No, like Jane Doe,10012345',
        '3:Put a comma between the name and the Application No, like Jane Doe,10012345',
    ]);
});

test('a box with no problems hands over each line already split into name and Application No', () => {
    const check = checkStudentLines('Student Name,Application No\n  Jane   Doe , 10012345 \nAnna Lee,20');
    assert.deepEqual(check.lines, [
        { text: 'Jane   Doe , 10012345', name: 'Jane Doe', admissionId: '10012345' },
        { text: 'Anna Lee,20', name: 'Anna Lee', admissionId: '20' },
    ]);
    assert.deepEqual(checkStudentLines('Jane Doe 1').lines, [], 'nothing is handed over while there are errors');
});

test('each flagged line carries the text as typed, so it can be shown in red', () => {
    const errors = checkStudentLines('Jane Doe,1\n  John Roe 2  ').errors;
    assert.deepEqual(errors.map((e) => [e.line, e.text]), [[2, 'John Roe 2']]);
});

test('one bad line among ten good ones is enough to flag the box', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Person ${String.fromCharCode(65 + i)},${i + 1}`);
    assert.equal(checkStudentLines(lines.join('\n')).errors.length, 0);
    lines[6] = 'Person G 7';
    const check = checkStudentLines(lines.join('\n'));
    assert.deepEqual(check.errors.map((e) => e.line), [7]);
});

test('line numbers count blank lines and the header, like the box shows them', () => {
    assert.deepEqual(messages('Student Name,Application No\n\nJane Doe 10012345').map((m) => m.split(':')[0]), ['3']);
});

test('more than one comma, a missing name or number, and a bad number are each flagged', () => {
    assert.deepEqual(messages('A,B,C'), ['1:Use only one comma, between the name and the Application No']);
    assert.deepEqual(messages(',10'), ['1:The student name is missing']);
    assert.deepEqual(messages('Jane Doe,'), ['1:The Application No is missing']);
    for (const bad of ['12AB', 'AB12', '12.5', '-5', '+5', '0', '000', '1 2']) {
        assert.match(messages(`Jane Doe,${bad}`)[0], /^1:The Application No must be a whole number, digits only/, bad);
    }
    assert.deepEqual(checkStudentLines('Jane Doe,007').errors, [], 'leading zeros are fine');
});

test('more than the limit is flagged once for the box as a whole', () => {
    const many = Array.from({ length: MAX_STUDENT_LINES + 1 }, (_, i) => `Person ${String.fromCharCode(65 + i)},${i + 1}`).join('\n');
    const check = checkStudentLines(many);
    assert.equal(check.count, MAX_STUDENT_LINES + 1);
    assert.deepEqual(check.errors.map((e) => e.line), [0]);
    assert.equal(checkStudentLines(many.split('\n').slice(0, MAX_STUDENT_LINES).join('\n')).errors.length, 0);
});

// Parity with the server: for each sample line the box says "problem" exactly
// when the server fails that line for a format reason.
mock.module('../src/db.ts', { exports: { db: { query: async (sql) => (sql.includes('INSERT') ? { rowCount: 1, rows: [] } : { rowCount: 0, rows: [] }) } } });
const { autoAddStudents } = await import('../src/autoAdd.ts');
const fakeMigadu = { domain: 'myemailinfo.com', exists: async () => false, create: async () => {}, remove: async () => {} };

test('the box and the server agree on which lines are wrong', async () => {
    const samples = [
        'Jane Doe,10012345', 'John Roe , 10012346', 'Anna Lee,20', 'Jane Doe,007', 'iqura,5', 'ZAID KHAN JAKIR KHAN PATHAN,6',
        'Bankim chandar das chatterjee,5', '   Jane   Doe  ,  7  ', 'Jane Doe ,5,',
        'Jane D0e,5', "O'Brien Sean,5", 'Mary-Anne Lee,5', 'Renée Lee,5', 'Dr. Smith,5', '"Khan, Ali",20',
        'Jane Doe 10012345', 'Jane Doe\t10012345', 'Jane Doe', 'A,B,C', ',10', 'Jane Doe,',
        'Jane Doe,12AB', 'Jane Doe,12.5', 'Jane Doe,-5', 'Jane Doe,0', 'KHAN, ALI 32299', '(((),5',
    ];
    for (const [index, sample] of samples.entries()) {
        const server = await autoAddStudents(`${sample}`.replace(/^(.*)$/, '$1'), 'c@example.test', '3', 'IHSM ELITE', fakeMigadu);
        const serverFailed = server.rows[0].status === 'failed';
        const boxFlags = checkStudentLines(sample).errors.length > 0;
        assert.equal(boxFlags, serverFailed, `sample ${index}: ${JSON.stringify(sample)}`);
    }
});

test('a name must be letters and spaces only, for first, middle and last names alike', () => {
    for (const ok of ['Jane Doe', 'JANE DOE', 'jane doe', 'Samyak Meshram', 'ZAID KHAN JAKIR KHAN PATHAN', 'iqura', 'Jane   Doe']) {
        assert.deepEqual(checkStudentLines(`${ok},5`).errors, [], ok);
    }
    for (const bad of ['Jane D0e', "O'Brien Sean", 'Mary-Anne Lee', 'Renée Lee', 'Dr. Smith', 'Jane Doe 2nd', '(((']) {
        assert.deepEqual(messages(`${bad},5`), ['1:The name can only have letters (A to Z) and spaces - no numbers, dots, hyphens or other symbols'], bad);
    }
});

test('names of four and five words are fine', () => {
    for (const ok of ['Bankim chandar das chatterjee', 'ZAID KHAN JAKIR KHAN PATHAN', 'Anna Maria Louise Van Der Berg']) {
        assert.deepEqual(checkStudentLines(`${ok},5`).errors, [], ok);
    }
});

test('spaces before the name, around the comma and after the number do not matter', () => {
    const variants = ['Jane Doe,10012345', '  Jane Doe,10012345', 'Jane Doe ,10012345', 'Jane Doe, 10012345', 'Jane Doe,10012345  ', '   Jane   Doe   ,   10012345   ', '\u00a0Jane Doe,10012345'];
    for (const v of variants) {
        const check = checkStudentLines(v);
        assert.deepEqual(check.errors, [], JSON.stringify(v));
        assert.deepEqual(check.lines.map((l) => [l.name, l.admissionId]), [['Jane Doe', '10012345']], JSON.stringify(v));
    }
});

test('Windows, Unix and old Mac line endings, mixed or not, all work and keep the line numbers', () => {
    for (const eol of ['\r\n', '\n', '\r']) {
        const check = checkStudentLines(['Jane Doe,1', 'John Roe,2', 'Ann Lee,3'].join(eol));
        assert.deepEqual(check.errors, [], JSON.stringify(eol));
        assert.equal(check.count, 3);
    }
    assert.equal(checkStudentLines('Jane Doe,1\r\nJohn Roe,2\nAnn Lee,3\r').count, 3, 'mixed endings and a trailing one');
    assert.deepEqual(messages('Jane Doe,1\r\nJohn Roe 2\r\nAnn Lee,3').map((m) => m.split(':')[0]), ['2'], 'the line number is right with CRLF');
});

test('exactly one comma: none, two or more are flagged, a name and a number must be on either side', () => {
    assert.equal(messages('Jane Doe 5').length, 1);
    assert.deepEqual(messages('Jane Doe,5,6'), ['1:Use only one comma, between the name and the Application No']);
    assert.deepEqual(messages('Jane,Doe,5'), ['1:Use only one comma, between the name and the Application No']);
    assert.deepEqual(messages('"Khan, Ali",20'), ['1:Use only one comma, between the name and the Application No']);
    assert.deepEqual(messages(',5'), ['1:The student name is missing']);
    assert.deepEqual(messages('Jane Doe,'), ['1:The Application No is missing']);
    assert.deepEqual(messages('5,Jane Doe').length, 1, 'number before the comma is refused');
});
