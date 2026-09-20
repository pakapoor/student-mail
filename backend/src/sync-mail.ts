import "dotenv/config";
import { db } from "./db.js";
import { syncInbox } from "./sync.js";

async function main() {
    console.log("Connecting to central inbox...");

    const { inserted, skipped } = await syncInbox(
        process.env.CENTRAL_EMAIL!,
        process.env.CENTRAL_EMAIL_PASSWORD!
    );

    console.log("\nSYNC COMPLETE");
    console.log("Inserted :", inserted);
    console.log("Duplicates:", skipped);

    await db.end();
}

main().catch((error) => {
    console.error("\nSYNC FAILED");
    console.error(error);
    process.exit(1);
});
