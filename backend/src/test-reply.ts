import "dotenv/config";
import path from "node:path";
import { db } from "./db.js";
import { fetchMessageById, fetchMessages, sendReply } from "./reply.js";

async function main() {
    const messageIdArg = process.argv[2];
    const attachmentArg = process.argv[3];

    const attachments = attachmentArg
        ? attachmentArg.split(",").map((filePath) => ({
              filename: path.basename(filePath),
              path: filePath,
          }))
        : [];

    const centralEmail = process.env.CENTRAL_EMAIL!;
    // Messages are now college-scoped (Step 6); this old one-off CLI script
    // needs a college id to look one up. Not part of the live app.
    const collegeId = process.env.CENTRAL_COLLEGE_ID!;

    const message = messageIdArg
        ? await fetchMessageById(Number(messageIdArg), centralEmail, collegeId)
        : (await fetchMessages("pending", centralEmail, collegeId))[0];

    if (!message) {
        console.log("No pending message found.");
        await db.end();
        return;
    }

    console.log("Replying to message:");
    console.log("  id            :", message.id);
    console.log("  student_email :", message.student_email);
    console.log("  sender_email  :", message.sender_email);
    console.log("  subject       :", message.subject);
    console.log("  message_id    :", message.message_id);

    console.log(
        "\nSending via Migadu SMTP as",
        message.student_email,
        "..."
    );

    const bodyText =
        "This is a test reply sent automatically to verify SMTP " +
        "threading, BCC, and reply-state tracking.";

    const info = await sendReply(message, bodyText, attachments);

    console.log("SMTP SEND SUCCEEDED");
    console.log("  sent message_id:", info.messageId);
    console.log("\nDB updated: replied = true, reply row inserted.");

    await db.end();
}

main().catch((error) => {
    console.error("\nREPLY TEST FAILED");
    console.error(error);
    process.exit(1);
});
