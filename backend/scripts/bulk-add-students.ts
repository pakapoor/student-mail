// Step 50: add many students on the server exactly as the Add students screen
// does, run by hand (never part of `npm test`: it creates real mailboxes and
// sends real mail).
//
//   cd backend && npx tsx scripts/bulk-add-students.ts "COLLEGE NAME" < lines.csv
//
// stdin: "Student Name,Application No" lines (a header line is fine). They are
// added 10 at a time with autoAddStudents (Migadu mailbox, student saved hidden,
// TEST email sent); then each added student is checked with testNewMailbox, the
// code behind POST /api/students/test-mailbox, until the TEST email has arrived
// ("received") or the 60 s limit has failed the add ("failed"). After a batch
// with any failure the script stops, so a Migadu sending limit cannot fail the
// whole list. One JSON line per student on stdout; never a password.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { db } from "../src/db.js";
import { autoAddStudents, AUTO_ADD_MAX_ROWS } from "../src/autoAdd.js";
import { testNewMailbox } from "../src/mailboxTest.js";

const COLLEGE_NAME = process.argv[2] ?? "";
const CENTRAL_EMAIL = process.env.ACTIVE_CENTRAL_EMAIL ?? "";
const IP = "bulk-add-script";
const ASK_AGAIN_MS = 1000;

async function main(): Promise<number> {
    if (!COLLEGE_NAME || !CENTRAL_EMAIL) {
        console.error('Usage: npx tsx scripts/bulk-add-students.ts "COLLEGE NAME" < lines.csv (needs ACTIVE_CENTRAL_EMAIL)');
        return 2;
    }

    const college = await db.query<{ id: string }>("SELECT id FROM colleges WHERE name = $1", [COLLEGE_NAME]);
    const collegeId = college.rows[0]?.id;

    if (!collegeId) {
        console.error(`No college named ${COLLEGE_NAME}`);
        return 2;
    }

    const lines = readFileSync(0, "utf8")
        .split(/\r\n|\n|\r/)
        .filter((line) => line.trim().length > 0 && line.trim().toLowerCase() !== "student name,application no");
    const who = { central: CENTRAL_EMAIL, college: COLLEGE_NAME, ip: IP };
    let failures = 0;

    for (let start = 0; start < lines.length; start += AUTO_ADD_MAX_ROWS) {
        const batch = lines.slice(start, start + AUTO_ADD_MAX_ROWS);
        const result = await autoAddStudents(batch.join("\n"), CENTRAL_EMAIL, collegeId, COLLEGE_NAME, undefined, IP);

        await Promise.all(
            result.rows.map(async (row) => {
                let state: string = row.status;
                let seconds: number | null | undefined;

                if (row.status === "added" && row.email) {
                    for (;;) {
                        const test = await testNewMailbox(row.email, who, collegeId);
                        state = test?.state ?? "failed";
                        seconds = test?.seconds;

                        if (state !== "waiting") break;
                        await new Promise((resolve) => setTimeout(resolve, ASK_AGAIN_MS));
                    }
                }

                if (state !== "received") failures++;
                console.log(JSON.stringify({ name: row.name, applicationNo: row.admissionId, email: state === "received" ? row.email : null, state, seconds, reason: row.reason }));
            })
        );

        if (failures > 0) {
            console.error(`Stopped after a batch with ${failures} not received; ${lines.length - start - batch.length} lines not tried.`);
            return 1;
        }
    }

    return 0;
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => db.end());
