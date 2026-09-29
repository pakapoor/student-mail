import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Fake database: no existing students, records the INSERT parameters.
const inserts = [];
mock.module('../src/db.ts', { exports: { db: { query: async (sql, params) => {
    if (sql.includes('INSERT INTO students')) { inserts.push(params); return { rowCount: 1, rows: [] }; }
    return { rowCount: 0, rows: [] };
} } } });
const { importStudents, parseImportYear } = await import('../src/students.ts');
const thisYear = new Date().getUTCFullYear();

test('a blank or missing year is the current year', () => {
    assert.deepEqual(parseImportYear(undefined, 2026), { year: 2026 });
    assert.deepEqual(parseImportYear('', 2026), { year: 2026 });
    assert.deepEqual(parseImportYear('  ', 2026), { year: 2026 });
});

test('a 4-digit year within 2 years is accepted, anything else is not', () => {
    assert.deepEqual(parseImportYear('2024', 2026), { year: 2024 });
    assert.deepEqual(parseImportYear('2028', 2026), { year: 2028 });
    for (const bad of ['2023', '2029', '26', 'abcd', '20260', '2026.5', '-2026']) {
        assert.ok('error' in parseImportYear(bad, 2026), `${bad} is rejected`);
    }
});

test('rows without a year get the current year; an explicit year is kept', async () => {
    inserts.length = 0;
    const result = await importStudents(
        `Ann One,1001,ann@example.test,pw1\nBob Two,1002,bob@example.test,,${thisYear - 1}\nCy Three,1003,cy@example.test,pw3,${thisYear}`,
        'c@example.test', '1', 'KSMA CENTRAL');
    assert.equal(result.imported, 3);
    assert.deepEqual(inserts.map(p => p[9]), [thisYear, thisYear - 1, thisYear]);
    assert.equal(inserts[1][4], 'password', 'blank password with a year still gets the default');
});

test('a bad year rejects that row only, with a reason', async () => {
    inserts.length = 0;
    const result = await importStudents(
        `Ann One,1001,ann@example.test,pw1,${thisYear + 5}\nBob Two,1002,bob@example.test,pw2,26\nCy Three,1003,cy@example.test,pw3`,
        'c@example.test', '1', 'KSMA CENTRAL');
    assert.equal(result.imported, 1);
    assert.equal(result.rejected.length, 2);
    assert.match(result.rejected[0].reason, /4-digit year within 2 years/);
    assert.equal(inserts.length, 1);
});

test('both header forms are skipped, the 4-column one as before', async () => {
    for (const header of ['Student Name,Application No,Email,Password', 'Student Name,Application No,Email,Password,Year', 'student name,application no,email,password,YEAR']) {
        inserts.length = 0;
        const result = await importStudents(`${header}\nAnn One,1001,ann@example.test,pw1`, 'c@example.test', '1', 'KSMA CENTRAL');
        assert.equal(result.imported, 1, header);
        assert.equal(result.rejected.length, 0, header);
    }
});
