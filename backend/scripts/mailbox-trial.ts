// Step 48: timing trial of new student mailboxes against REAL Migadu, run by hand
// (never part of `npm test`: it creates real mailboxes and sends real mail).
//
//   cd backend && npx tsx scripts/mailbox-trial.ts [count=10] [csv-path]
//
// For each of `count` random test students (name "TEST XXXXX YYYYY", address
// test.yyyyy@...), one after another like the Add students dialog: pick a free
// address, create the mailbox (password "password"), check it (Migadu lookup + IMAP
// login), send the TEST email from the central mailbox; then wait (1 s polls, up to
// 5 min) for it in the new mailbox and in central. Every step's start and end are
// recorded. Every mailbox it created is deleted at the end, even after a failure.
// Needs backend/.env (Migadu, IMAP, SMTP, database) and the central mailbox's
// password in central_mailboxes (logged in once through the console).
import "dotenv/config";
import { writeFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import pg from "pg";
import { migaduMailboxApi } from "../src/migadu.js";
import { emailBase, emailCandidates } from "../src/studentEmail.js";
import { TEST_SUBJECT } from "../src/mailboxTest.js";

const COUNT = Number(process.argv[2] ?? 10);
const CSV_PATH = process.argv[3] ?? null;
const CENTRAL_EMAIL = process.env.ACTIVE_CENTRAL_EMAIL || "central.ksma@myemailinfo.com";
const POLL_MS = 1000;
const LIMIT_MS = 5 * 60 * 1000;

const api = migaduMailboxApi();
const pool = new pg.Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const centralRow = (await pool.query<{ email: string; password: string }>("SELECT email, password FROM central_mailboxes WHERE email = $1", [CENTRAL_EMAIL])).rows[0];
await pool.end();

if (!centralRow) {
    console.error(`No password for ${CENTRAL_EMAIL} in central_mailboxes - log in through the console once first.`);
    process.exit(1);
}

const central = { email: centralRow.email, password: centralRow.password };
const smtp = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: true, auth: { user: central.email, pass: central.password } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const word = () => Array.from({ length: 5 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const iso = (t?: number) => (t ? new Date(t).toISOString() : "");

type Step = { start?: number; end?: number; note?: string };
const STEPS = ["pick", "create", "check", "send", "inbox", "central", "remove"] as const;
type Rec = { name: string; appNo: string; local: string; email: string; messageId: string } & Record<(typeof STEPS)[number], Step>;
const recs: Rec[] = [];
const created: string[] = [];

function imap(login: { email: string; password: string }): ImapFlow {
    const client = new ImapFlow({ host: process.env.IMAP_HOST!, port: Number(process.env.IMAP_PORT || 993), secure: true, auth: { user: login.email, pass: login.password }, logger: false });
    client.on("error", () => {});
    return client;
}

// Polls one INBOX every second for the wanted Message-IDs.
async function watch(login: { email: string; password: string }, wanted: () => string[], hit: (id: string, at: number) => void, done: () => boolean, deadline: number) {
    const client = imap(login);
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });
    const seen = new Set<number>();

    try {
        while (!done() && Date.now() < deadline) {
            const uids = ((await client.search({ since: new Date(Date.now() - 86400000) }, { uid: true })) || []).filter((uid) => !seen.has(uid));

            if (uids.length) {
                for await (const msg of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
                    seen.add(msg.uid);
                    const id = msg.envelope?.messageId;
                    if (id && wanted().includes(id)) hit(id, Date.now());
                }
            }

            await sleep(POLL_MS);
            await client.noop();
        }
    } finally {
        await client.logout().catch(() => {});
    }
}

const deadline = Date.now() + COUNT * 15000 + LIMIT_MS;
const watches: Promise<void>[] = [];

try {
    watches.push(
        watch(central, () => recs.filter((r) => r.send.end && !r.central.end && !r.send.note).map((r) => r.messageId),
            (id, at) => { const r = recs.find((x) => x.messageId === id); if (r) r.central.end = at; },
            () => recs.length === COUNT && recs.every((r) => r.send.end && (r.central.end || r.send.note)), deadline)
            .catch((error) => console.log(`central watch failed: ${error.message}`))
    );

    for (let i = 0; i < COUNT; i++) {
        const name = `TEST ${word().toUpperCase()} ${word().toUpperCase()}`;
        const r = { name, appNo: String(9_000_000_000 + Math.floor(Math.random() * 999_999_999)), local: "", email: "", messageId: "" } as Rec;
        for (const k of STEPS) r[k] = {};
        recs.push(r);

        r.pick.start = Date.now();
        for (const candidate of emailCandidates(emailBase(name)!, 50)) {
            if (!(await api.exists(candidate))) { r.local = candidate; break; }
        }
        r.pick.end = Date.now();
        r.email = `${r.local}@${api.domain}`;
        r.messageId = `<mailbox-trial-${r.local}-${Date.now()}@${api.domain}>`;

        r.create.start = Date.now();
        await api.create(r.local, name, "password");
        r.create.end = Date.now();
        created.push(r.local);

        r.check.start = Date.now();
        const found = await api.exists(r.local);
        let tries = 0;
        for (;;) {
            tries++;
            const client = imap({ email: r.email, password: "password" });
            try { await client.connect(); await client.logout().catch(() => {}); break; }
            catch (error) {
                if (Date.now() - r.check.start > 30000) { r.check.note = `login refused: ${(error as Error).message}`; break; }
                await sleep(1000);
            }
        }
        r.check.end = Date.now();
        r.check.note ??= `lookup ${found ? "found" : "MISSING"}, login tries ${tries}`;

        r.send.start = Date.now();
        try {
            await smtp.sendMail({ from: central.email, to: r.email, subject: TEST_SUBJECT, text: "TEST - mailbox timing trial. Please ignore.", messageId: r.messageId, headers: { "X-Student-Mail-Test": "1" } });
        } catch (error) {
            r.send.note = `send failed: ${(error as Error).message}`;
        }
        r.send.end = Date.now();

        if (!r.send.note) {
            r.inbox.start = r.central.start = r.send.end;
            watches.push(watch({ email: r.email, password: "password" }, () => [r.messageId], (_id, at) => { r.inbox.end = at; }, () => !!r.inbox.end, deadline)
                .catch((error) => { r.inbox.note = `watch failed: ${error.message}`; }));
        }

        console.log(`#${i + 1} ${r.email} created, checked, ${r.send.note ?? "sent"}`);
    }

    await Promise.all(watches);
} finally {
    for (const r of recs) {
        if (!created.includes(r.local)) continue;
        r.remove.start = Date.now();
        try { await api.remove(r.local); r.remove.note = (await api.exists(r.local)) ? "STILL EXISTS" : "gone"; }
        catch (error) { r.remove.note = `remove failed: ${(error as Error).message}`; }
        r.remove.end = Date.now();
    }
}

const secs = (s: Step) => (s.start && s.end ? ((s.end - s.start) / 1000).toFixed(2) : "—");
const total = (end: number | undefined, r: Rec) => (end && r.create.end ? ((end - r.create.end) / 1000).toFixed(2) : "NOT ARRIVED");
console.log("\n#  email                          pick create  check   send  inbox central | create→inbox create→central | notes");
recs.forEach((r, i) => console.log(
    `${String(i + 1).padEnd(3)}${r.email.padEnd(31)}${secs(r.pick).padStart(5)} ${secs(r.create).padStart(6)} ${secs(r.check).padStart(6)} ${secs(r.send).padStart(6)} ${secs(r.inbox).padStart(6)} ${secs(r.central).padStart(7)} | ${total(r.inbox.end, r).padStart(12)} ${total(r.central.end, r).padStart(14)} | ${[r.check.note, r.send.note, r.inbox.note, `removed: ${r.remove.note}`].filter(Boolean).join("; ")}`));
console.log("Seconds. Arrival is seen by a 1 s poll (up to ~1 s late); the inbox time includes logging in to the new mailbox.");

if (CSV_PATH) {
    writeFileSync(CSV_PATH, ["name,app_no,email," + STEPS.map((k) => `${k}_start,${k}_end`).join(",") + ",notes",
        ...recs.map((r) => [r.name, r.appNo, r.email, ...STEPS.flatMap((k) => [iso(r[k].start), iso(r[k].end)]),
            `"${[r.check.note, r.send.note, r.inbox.note, r.remove.note].filter(Boolean).join("; ")}"`].join(","))].join("\n"));
    console.log(`CSV: ${CSV_PATH}`);
}
