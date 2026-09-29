import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb } from './helpers/testdb.mjs';

const db = await startTestDb({ schema: false });
after(() => db?.stop());
const migration = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations/014_lower_email_indexes.sql');

test('migration 014 rejects old mixed-case mail, then normalizes new writes and reruns safely', { skip: !db }, async () => {
    await db.pool.query(`
        CREATE TABLE students (
            id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, first_name TEXT, last_name TEXT,
            central_email TEXT, deleted_at TIMESTAMPTZ, code_sent_at TIMESTAMPTZ,
            last_swept_at TIMESTAMPTZ, smtp_password TEXT NOT NULL DEFAULT '', college_id BIGINT
        );
        CREATE INDEX idx_students_sort ON students (first_name, last_name, id);
        CREATE INDEX idx_students_last_swept ON students (last_swept_at NULLS FIRST) WHERE deleted_at IS NULL;
        CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, student_email TEXT NOT NULL, edugate_kind TEXT);
        INSERT INTO students (email) VALUES ('Mixed@Example.Test');
        INSERT INTO messages (student_email) VALUES ('Mixed@Example.Test');
    `);

    const blocked = db.runSqlFile(migration);
    assert.equal(blocked.ok, false);
    assert.match(blocked.stderr, /migration 014 stopped: 1 student email\(s\) and 1 message/);
    assert.equal((await db.pool.query("SELECT to_regclass('idx_students_email_lower') AS index_name")).rows[0].index_name, null,
        'failed migration rolls back its index changes');

    await db.pool.query("UPDATE students SET email = lower(email)");
    await db.pool.query("UPDATE messages SET student_email = lower(student_email)");
    for (let pass = 0; pass < 2; pass++) {
        const applied = db.runSqlFile(migration);
        assert.equal(applied.ok, true, applied.stderr);
    }

    const indexes = (await db.pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname")).rows.map((row) => row.indexname);
    for (const name of ['idx_students_email_lower', 'idx_messages_student_email_lower', 'idx_students_roster_order',
        'idx_students_hot_code', 'idx_students_sweep', 'idx_students_college_email']) {
        assert.ok(indexes.includes(name), `${name} is present`);
    }
    assert.ok(!indexes.includes('idx_students_sort'));
    assert.ok(!indexes.includes('idx_students_last_swept'));

    await db.pool.query("INSERT INTO students (email) VALUES ('New@Example.Test')");
    await db.pool.query("INSERT INTO messages (student_email) VALUES ('New@Example.Test')");
    assert.equal((await db.pool.query("SELECT email FROM students WHERE email = 'new@example.test'")).rowCount, 1);
    assert.equal((await db.pool.query("SELECT student_email FROM messages WHERE student_email = 'new@example.test'")).rowCount, 1);
    await assert.rejects(db.pool.query("INSERT INTO students (email) VALUES ('NEW@EXAMPLE.TEST')"), /duplicate key/);

    await db.pool.query('SET enable_seqscan = off');
    const studentPlan = (await db.pool.query("EXPLAIN SELECT * FROM students WHERE lower(email) = lower('new@example.test')"))
        .rows.map((row) => row['QUERY PLAN']).join('\n');
    const messagePlan = (await db.pool.query("EXPLAIN SELECT * FROM messages WHERE lower(student_email) = lower('new@example.test')"))
        .rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(studentPlan, /idx_students_email_lower/);
    assert.match(messagePlan, /idx_messages_student_email_lower/);
});

test('fresh schema includes the migration 014 constraints and triggers', async () => {
    const fresh = await startTestDb();
    try {
        const constraints = (await fresh.pool.query("SELECT conname FROM pg_constraint WHERE conname LIKE '%email_lowercase' ORDER BY conname"))
            .rows.map((row) => row.conname);
        assert.deepEqual(constraints, ['messages_student_email_lowercase', 'students_email_lowercase']);
        await fresh.pool.query("INSERT INTO students (email, smtp_password) VALUES ('Fresh@Example.Test', 'pw')");
        assert.equal((await fresh.pool.query("SELECT email FROM students WHERE email = 'fresh@example.test'")).rowCount, 1);
    } finally {
        await fresh.stop();
    }
});
