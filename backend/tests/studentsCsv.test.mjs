// Step 51: the Search students list as a CSV (frontend/src/studentsCsv.ts):
// the list's columns only, never a password, quoting, file name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studentsCsv, studentsCsvFileName, STUDENTS_CSV_HEADER } from '../../frontend/src/studentsCsv.ts';

const row = (over = {}) => ({
    id: 1, first_name: 'AARAV', last_name: 'KUMAR', name: 'AARAV KUMAR', email: 'aarav.kumar@myemailinfo.com',
    admission_id: '2026001', year_enrolled: 2026, created_at: '2026-10-21T12:54:30Z', deleted_at: null,
    college_id: '7', college_name: 'KYRGYZ NATIONAL UNIVERSITY', registration_status: null,
    code_sent_at: null, registered_at: null, rejected_at: null, edugate_state: null, smtp_password: 'secret', ...over,
});

test('the header and columns are the list\'s, with no password', () => {
    const lines = studentsCsv([row()]).replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], STUDENTS_CSV_HEADER.join(','));
    assert.equal(lines[0], 'Name,Email,Application No,College,Year enrolled,Edugate status');
    assert.equal(lines[1], 'AARAV KUMAR,aarav.kumar@myemailinfo.com,2026001,KYRGYZ NATIONAL UNIVERSITY,2026,');
    assert.ok(!studentsCsv([row()]).includes('secret'));
});

test('starts with a byte order mark for Excel', () => {
    assert.ok(studentsCsv([]).startsWith('﻿'));
});

test('a value with a comma or quote is quoted', () => {
    const line = studentsCsv([row({ first_name: 'A, "B"', last_name: null })]).split('\r\n')[1];
    assert.ok(line.startsWith('"A, ""B""",'));
});

test('the Edugate status reads as on screen', () => {
    const line = studentsCsv([row({ edugate_state: 'registered', registered_at: '2026-10-03T08:44:00Z' })]).split('\r\n')[1];
    assert.match(line, /,"Registered - \d+ Oct, \d+:\d\d (AM|PM)"$/, "quoted: the date has a comma");
    const rejected = studentsCsv([row({ edugate_state: 'rejected', rejected_at: '2026-10-05T08:44:00Z', registered_at: '2026-10-03T08:44:00Z' })]).split('\r\n')[1];
    assert.match(rejected, /,"Rejected - .*; registered .*"$/);
});

test('the file name names the college and the date', () => {
    const day = new Date(2026, 9, 21);
    assert.equal(studentsCsvFileName('KYRGYZ NATIONAL UNIVERSITY', day), 'students-KYRGYZ-NATIONAL-UNIVERSITY-2026-10-21.csv');
    assert.equal(studentsCsvFileName(null, day), 'students-all-colleges-2026-10-21.csv');
});
