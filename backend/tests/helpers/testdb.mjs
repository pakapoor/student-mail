// A throwaway PostgreSQL for tests that need real SQL behaviour (indexes,
// triggers, the query text itself). Each test file that asks for one gets its
// own cluster in a temp directory, on a free loopback port, with fsync off,
// loaded from schema.sql - nothing touches the development or production
// databases, and it is deleted afterwards. If no PostgreSQL server binaries
// are installed (set PG_BIN to override the search) startTestDb() returns
// null and the tests that need it skip themselves.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(here, '../../schema.sql');

function findBin() {
    const candidates = [];

    // PG_BIN, when set, is the only place looked in.
    if (process.env.PG_BIN) {
        const dir = process.env.PG_BIN;
        return existsSync(path.join(dir, 'initdb')) && existsSync(path.join(dir, 'pg_ctl')) ? dir : undefined;
    }

    for (const root of ['/usr/lib/postgresql', '/usr/local/pgsql', '/opt/homebrew/opt/postgresql@16']) {
        if (!existsSync(root)) continue;
        if (existsSync(path.join(root, 'bin', 'initdb'))) candidates.push(path.join(root, 'bin'));
        for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) candidates.push(path.join(root, v, 'bin'));
    }
    return candidates.find((dir) => existsSync(path.join(dir, 'initdb')) && existsSync(path.join(dir, 'pg_ctl')));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

export const postgresAvailable = Boolean(findBin());

export async function startTestDb({ schema = true } = {}) {
    const bin = findBin();

    if (!bin) {
        // `npm run check` sets REQUIRE_PG=1: a missing PostgreSQL must fail the
        // check, not quietly skip the tests that matter most.
        if (process.env.REQUIRE_PG) {
            throw new Error('PostgreSQL server binaries (initdb, pg_ctl) were not found, and REQUIRE_PG is set. Install PostgreSQL or set PG_BIN.');
        }

        return null;
    }

    const dir = mkdtempSync(path.join(os.tmpdir(), 'ism-testdb-'));
    const port = await freePort();
    const run = (tool, args) => execFileSync(path.join(bin, tool), args, { stdio: 'pipe' });

    run('initdb', ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'test']);
    run('pg_ctl', [
        '-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), 'start', '-o',
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=60`,
    ]);

    const admin = new pg.Pool({ host: '127.0.0.1', port, user: 'test', database: 'postgres', max: 1 });
    await admin.query('CREATE DATABASE app');
    await admin.end();

    const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'test', database: 'app', max: 8 });
    if (schema) await pool.query(readFileSync(SCHEMA, 'utf8'));

    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        try { await pool.end(); } catch { /* already closed */ }
        spawnSync(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
        rmSync(dir, { recursive: true, force: true });
    };
    process.on('exit', () => {
        if (stopped) return;
        spawnSync(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
        rmSync(dir, { recursive: true, force: true });
    });

    // Run a .sql file the way it is run at deploy time (psql -f, stop at the
    // first error) - needed for migrations, which end with a VACUUM that
    // cannot run inside a multi-statement string.
    const runSqlFile = (file) => {
        const r = spawnSync(path.join(bin, 'psql'), ['-X', '-q', '-h', '127.0.0.1', '-p', String(port), '-U', 'test', '-d', 'app', '-v', 'ON_ERROR_STOP=1', '-f', file], { encoding: 'utf8' });
        return { ok: r.status === 0, stderr: r.stderr, stdout: r.stdout };
    };

    return { pool, port, stop, runSqlFile, reset: () => pool.query('TRUNCATE messages, replies, students, sessions, status_problems, central_mailboxes RESTART IDENTITY CASCADE') };
}

// Small builders so a test reads as a story about students and mail.
export function builders(pool) {
    let n = 0;
    const iso = (value) => (value instanceof Date ? value.toISOString() : value);

    return {
        async college(name) {
            const r = await pool.query('INSERT INTO colleges (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id', [name]);
            return String(r.rows[0].id);
        },
        async student({ email, first = 'Ann', last = 'Lee', college = 1, central = 'central@example.test', admission, deleted = false, password = 'pw123456', registeredAt = null } = {}) {
            n++;
            const address = email ?? `student${n}@example.test`;
            await pool.query(
                `INSERT INTO students (email, smtp_password, name, first_name, last_name, central_email, college_id, admission_id, deleted_at, registered_at, year_enrolled)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 2026)`,
                [address, password, `${first} ${last}`, first, last, central, college, admission ?? String(100000 + n), deleted ? new Date() : null, iso(registeredAt)]
            );
            return address;
        },
        async message({ student, at = new Date(), sent, sender = 'parent@example.test', subject = 'Hello', body = 'Hello there', html = null, kind = null, replied = false, repliedAt = null, handled = false, inReplyTo = null, refs = [], central = 'central@example.test', id } = {}) {
            n++;
            const messageId = id ?? `<m${n}@test>`;
            const r = await pool.query(
                `INSERT INTO messages (message_id, student_email, sender_email, subject, received_at, sent_at, replied, replied_at,
                                       handled_without_reply, body_text, body_html, in_reply_to, reference_ids, central_email, edugate_kind)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
                [messageId, student, sender, subject, iso(at), sent === undefined ? null : iso(sent), replied, iso(repliedAt), handled, body, html, inReplyTo, refs, central, kind]
            );
            return { id: String(r.rows[0].id), messageId };
        },
        async reply({ to, student, at = new Date(), recipient = 'parent@example.test', body = 'Thanks' } = {}) {
            n++;
            await pool.query(
                `INSERT INTO replies (incoming_message_id, student_email, recipient_email, sent_message_id, sent_at, body_text) VALUES ($1, $2, $3, $4, $5, $6)`,
                [to, student, recipient, `<out${n}@test>`, iso(at), body]
            );
        },
        code: (digits = '123456', minutes = 30) => `Your verification code:\n\n${digits}\n\nEnter this code. The code is valid for ${minutes} minutes.\n`,
        login: (email, password = 'Secret99') => `Login (Email):\n${email} Password:\n${password}\n\n`,
        rejection: (doc = 'Passport', note = 'Please upload a clearer scan.') =>
            `\n--------------------\n\nHello, Ann Lee!\n\n❌ DOCUMENT REJECTED\n\nDocument: ${doc}\n\n${note}\n\nReviewed by: Admin, 29.09.2026 10:00\n`,
    };
}
