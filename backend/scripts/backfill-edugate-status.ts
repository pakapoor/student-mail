// One-off backfill for migration 010 (Edugate registration status).
//
//   npx tsx scripts/backfill-edugate-status.ts           # dry run: read + report only
//   npx tsx scripts/backfill-edugate-status.ts --apply   # write
//
// 1. messages.sent_at: read the Date: header of every email in each central
//    mailbox over IMAP (read-only - EXAMINE, headers only) and match by
//    Message-ID. Emails not found there keep NULL (status then falls back
//    to received_at for them).
// 2. messages.edugate_kind: classify every stored email with the same
//    verified templates the app uses (shared/edugate.ts).
// 3. students.registration_status / code_sent_at / registered_at:
//    recomputed from the messages (RECOMPUTE_ALL_SQL).
// Only these new columns are written; nothing else changes. Take a DB
// backup first. Safe to re-run.

import "dotenv/config";
import { ImapFlow } from "imapflow";
import { db } from "../src/db.js";
import { classifyEdugate, isEdugateSender, type EdugateKind } from "../../shared/edugate.js";
import { RECOMPUTE_ALL_SQL } from "../src/registrationStatus.js";

const apply = process.argv.includes("--apply");

interface MessageRow {
    id: string;
    message_id: string;
    student_email: string;
    sender_email: string;
    body_text: string | null;
    received_at: Date;
    sent_at: Date | null;
    edugate_kind: EdugateKind | null;
}

async function sentTimesFromMailbox(email: string, password: string): Promise<Map<string, Date>> {
    const client = new ImapFlow({
        host: process.env.IMAP_HOST!,
        port: Number(process.env.IMAP_PORT || 993),
        secure: true,
        auth: { user: email, pass: password },
        logger: false,
    });
    client.on("error", () => {});
    const found = new Map<string, Date>();

    await client.connect();

    try {
        const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });

        if (mailbox.exists > 0) {
            for await (const msg of client.fetch("1:*", { envelope: true })) {
                const id = msg.envelope?.messageId;
                const date = msg.envelope?.date;

                if (id && date && !Number.isNaN(new Date(date).getTime())) {
                    found.set(id, new Date(date));
                }
            }
        }
    } finally {
        await client.logout().catch(() => client.close());
    }

    return found;
}

async function main() {
    console.log(`backfill-edugate-status: ${apply ? "APPLY" : "DRY RUN (no writes)"} on ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);

    // 1. Sent times from the central mailboxes' headers.
    const sentTimes = new Map<string, Date>();
    const mailboxes = await db.query<{ email: string; password: string }>(
        "SELECT email, password FROM central_mailboxes"
    );

    for (const mb of mailboxes.rows) {
        try {
            const found = await sentTimesFromMailbox(mb.email, mb.password);
            found.forEach((date, id) => sentTimes.set(id, date));
            console.log(`  ${mb.email}: ${found.size} Date headers read`);
        } catch (error) {
            console.log(`  ${mb.email}: could not read (${error instanceof Error ? error.message : error}) - its emails keep sent_at NULL`);
        }
    }

    // 2. Classify every stored email; work out what would change. A dry run
    // also works before migration 010 (columns read as NULL), so the result
    // can be previewed on production before anything is changed there.
    const hasColumns = (await db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'edugate_kind'"
    )).rowCount === 1;

    if (!hasColumns && apply) {
        throw new Error("migration 010 not applied - run it before --apply");
    }

    const newColumns = hasColumns ? "sent_at, edugate_kind" : "NULL::timestamptz AS sent_at, NULL::text AS edugate_kind";
    const rows = (await db.query<MessageRow>(
        `SELECT id, message_id, student_email, sender_email, body_text, received_at, ${newColumns} FROM messages`
    )).rows;

    const updates: { id: string; sentAt: Date | null; kind: EdugateKind | null }[] = [];
    const kinds: Record<string, number> = {};
    let sentFound = 0;
    let unknownEdugate = 0;
    const perStudent = new Map<string, { code: number | null; login: number | null }>();

    for (const row of rows) {
        const sentAt = row.sent_at ?? sentTimes.get(row.message_id) ?? null;
        const kind = classifyEdugate(row.sender_email, row.body_text, row.student_email)?.kind ?? null;

        if (sentAt) sentFound++;
        kinds[kind ?? "none"] = (kinds[kind ?? "none"] ?? 0) + 1;
        if (isEdugateSender(row.sender_email) && !kind) unknownEdugate++;

        if (String(sentAt) !== String(row.sent_at) || kind !== row.edugate_kind) {
            updates.push({ id: row.id, sentAt, kind });
        }

        if (kind === "code" || kind === "login") {
            const at = (sentAt ?? row.received_at).getTime();
            const s = perStudent.get(row.student_email.toLowerCase()) ?? { code: null, login: null };
            s[kind] = Math.max(s[kind] ?? -Infinity, at);
            perStudent.set(row.student_email.toLowerCase(), s);
        }
    }

    const statuses = { REGISTERED: 0, REGISTRATION_PENDING: 0, "REGISTERED + newer code": 0 };
    for (const s of perStudent.values()) {
        if (s.login !== null) {
            statuses.REGISTERED++;
            if (s.code !== null && s.code > s.login) statuses["REGISTERED + newer code"]++;
        } else {
            statuses.REGISTRATION_PENDING++;
        }
    }

    console.log(`\nmessages: ${rows.length}, with a sent time: ${sentFound}, rows to update: ${updates.length}`);
    console.log("edugate_kind:", kinds);
    console.log(`Edugate emails matching no known template: ${unknownEdugate}`);
    console.log("students by resulting status:", statuses, `(everyone else stays NULL)`);

    if (!apply) {
        console.log("\nDry run - nothing written. Re-run with --apply to write.");
        return;
    }

    // 3. Write, all or nothing.
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        for (const u of updates) {
            await client.query("UPDATE messages SET sent_at = $2, edugate_kind = $3 WHERE id = $1", [u.id, u.sentAt, u.kind]);
        }

        const recomputed = await client.query(RECOMPUTE_ALL_SQL);
        await client.query("COMMIT");
        console.log(`\nWritten: ${updates.length} messages updated, ${recomputed.rowCount} students' status set.`);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    const check = await db.query<{ registration_status: string | null; n: string }>(
        "SELECT registration_status, count(*) AS n FROM students WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1"
    );
    console.log("students now (active):", Object.fromEntries(check.rows.map((r) => [r.registration_status ?? "NULL", Number(r.n)])));
}

main()
    .catch((error) => {
        console.error("backfill failed:", error);
        process.exitCode = 1;
    })
    .finally(() => db.end());
