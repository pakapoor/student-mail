import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import multer from "multer";
import { db } from "./db.js";
import { findCollege, listColleges } from "./colleges.js";
import {
    AlreadyRepliedError,
    StudentDeletedError,
    fetchMessageById,
    fetchMessages,
    markHandled,
    sendReply,
} from "./reply.js";
import { fetchThread, fetchThreadSummaries } from "./thread.js";
import { ensureWatcher, triggerSync } from "./mailboxSync.js";
import { addClient, broadcast, removeClient } from "./realtime.js";
import {
    createSession,
    destroySession,
    getSession,
    setSessionCollege,
    SESSION_COOKIE,
    verifyImapLogin,
} from "./auth.js";
import {
    listCentralMailboxes,
    registerCentralMailbox,
} from "./centralMailboxes.js";
import { fetchStudents, importStudents } from "./students.js";
import {
    pendingCountsForStudents,
    restoreStudent,
    searchAdminStudents,
    softDeleteStudents,
} from "./studentsAdmin.js";

const upload = multer({ dest: "uploads/" });

const app = express();

const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: frontendOrigin, credentials: true }));
app.use(express.json());
app.use(cookieParser());

function requireAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = getSession(token);

    if (!session) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    res.locals.centralEmail = session.email;
    res.locals.college = session.college;
    next();
}

// Chain after requireAuth on any route that reads/writes college-scoped
// data. Kept separate from requireAuth itself because /api/auth/college -
// the endpoint used to select a college for the first time - only needs a
// logged-in session, not a college already on it (that route requiring its
// own prerequisite would be a deadlock).
function requireCollege(
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    if (!res.locals.college) {
        res.status(400).json({ error: "Select a college" });
        return;
    }

    res.locals.collegeId = res.locals.college.id;
    next();
}

app.get("/api/colleges", async (_req, res) => {
    res.json(await listColleges());
});

app.post("/api/auth/login", async (req, res) => {
    const email =
        typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password =
        typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
        res.status(400).json({ error: "Email and password are required" });
        return;
    }

    const ok = await verifyImapLogin(email, password);

    if (!ok) {
        res.status(401).json({ error: "Invalid central mailbox credentials" });
        return;
    }

    await registerCentralMailbox(email, password);
    ensureWatcher(email, password);
    triggerSync(email, password);

    const token = createSession(email);

    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: false, // dev over plain HTTP; set true behind HTTPS in production
        maxAge: 1000 * 60 * 60 * 24 * 7,
    });

    res.json({ email, college: null });
});

app.post("/api/auth/college", requireAuth, async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];

    const collegeId = req.body?.collegeId;
    // IDs are strings because PostgreSQL BIGINT values are returned as strings.
    if (typeof collegeId !== "string" || !/^[1-9][0-9]{0,18}$/.test(collegeId)
        || BigInt(collegeId) > 9223372036854775807n) {
        res.status(400).json({ error: "Select a valid college" });
        return;
    }

    const college = await findCollege(collegeId);
    if (!college) {
        res.status(400).json({ error: "Select a valid college" });
        return;
    }

    setSessionCollege(token, college);

    res.json({ email: res.locals.centralEmail, college });
});

app.post("/api/auth/logout", (req, res) => {
    destroySession(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE);
    res.json({ loggedOut: true });
});

app.get("/api/auth/me", (req, res) => {
    const session = getSession(req.cookies?.[SESSION_COOKIE]);

    if (!session) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    res.json({ email: session.email, college: session.college ?? null });
});

app.get("/api/students", requireAuth, requireCollege, async (req, res) => {
    const students = await fetchStudents(res.locals.centralEmail, res.locals.collegeId);
    res.json(students);
});

app.post("/api/students/import", requireAuth, requireCollege, async (req, res) => {
    const csv = typeof req.body?.csv === "string" ? req.body.csv : "";

    if (!csv.trim()) {
        res.status(400).json({ error: "CSV text is required" });
        return;
    }

    const result = await importStudents(csv, res.locals.centralEmail, res.locals.collegeId);
    res.json(result);
});

// Admin roster - scoped to the logged-in operator's own central mailbox and
// selected college (same scope as /api/students), not cross-operator.
app.get("/api/admin/students", requireAuth, requireCollege, async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const deleted = req.query.deleted === "true";

    const page = await searchAdminStudents({
        centralEmail: res.locals.centralEmail,
        collegeId: res.locals.collegeId,
        search,
        cursor,
        deleted,
    });
    res.json(page);
});

app.post("/api/admin/students/pending-counts", requireAuth, requireCollege, async (req, res) => {
    const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(Number).filter((n: number) => Number.isInteger(n))
        : [];

    const counts = await pendingCountsForStudents(ids, res.locals.centralEmail, res.locals.collegeId);
    res.json(counts);
});

app.post("/api/admin/students/delete", requireAuth, requireCollege, async (req, res) => {
    const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(Number).filter((n: number) => Number.isInteger(n))
        : [];

    if (ids.length === 0) {
        res.status(400).json({ error: "No student ids provided" });
        return;
    }

    if (ids.length > 5) {
        res.status(400).json({ error: "Cannot delete more than 5 students at a time" });
        return;
    }

    const deletedCount = await softDeleteStudents(ids, res.locals.centralEmail, res.locals.collegeId);
    res.json({ deleted: deletedCount });
});

app.post("/api/admin/students/:id/restore", requireAuth, requireCollege, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid student id" });
        return;
    }

    const ok = await restoreStudent(id, res.locals.centralEmail, res.locals.collegeId);

    if (!ok) {
        res.status(404).json({ error: "Student not found or not deleted" });
        return;
    }

    res.json({ restored: true });
});

app.get("/api/messages", requireAuth, requireCollege, async (req, res) => {
    const status = req.query.status;

    const normalized =
        status === "all" || status === "replied" ? status : "pending";

    const messages = await fetchMessages(normalized, res.locals.centralEmail, res.locals.collegeId);
    res.json(messages);
});

app.get("/api/threads", requireAuth, requireCollege, async (req, res) => {
    const status = req.query.status;

    const normalized = status === "replied" ? status : "pending";

    const limitParam = Number(req.query.limit);
    const offsetParam = Number(req.query.offset);

    const limit = Number.isInteger(limitParam)
        ? Math.min(Math.max(limitParam, 1), 100)
        : 25;

    const offset =
        Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

    const page = await fetchThreadSummaries(
        normalized,
        res.locals.centralEmail,
        res.locals.collegeId,
        limit,
        offset
    );
    res.json(page);
});

app.get("/api/messages/:id", requireAuth, requireCollege, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid message id" });
        return;
    }

    const message = await fetchMessageById(id, res.locals.centralEmail, res.locals.collegeId);

    if (!message) {
        res.status(404).json({ error: "Message not found" });
        return;
    }

    res.json(message);
});

app.get("/api/events", requireAuth, requireCollege, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    req.socket.setNoDelay(true);

    const centralEmail = res.locals.centralEmail;

    addClient(res, centralEmail);
    res.write(": connected\n\n");
    console.log(`SSE client connected [${centralEmail}]`);

    req.on("close", () => {
        console.log(`SSE client disconnected [${centralEmail}]`);
        removeClient(res);
    });
});

app.get("/api/messages/:id/thread", requireAuth, requireCollege, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid message id" });
        return;
    }

    const items = await fetchThread(id, res.locals.centralEmail, res.locals.collegeId);

    if (!items) {
        res.status(404).json({ error: "Message not found" });
        return;
    }

    res.json(items);
});

app.post(
    "/api/messages/:id/reply",
    requireAuth,
    requireCollege,
    upload.array("attachments"),
    async (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isInteger(id)) {
            res.status(400).json({ error: "Invalid message id" });
            return;
        }

        const centralEmail = res.locals.centralEmail;
        const message = await fetchMessageById(id, centralEmail, res.locals.collegeId);

        if (!message) {
            res.status(404).json({ error: "Message not found" });
            return;
        }

        if (message.replied) {
            res.status(409).json({ error: "Message already replied to" });
            return;
        }

        const bodyText =
            typeof req.body?.body === "string" ? req.body.body.trim() : "";

        if (!bodyText) {
            res.status(400).json({ error: "Reply body is required" });
            return;
        }

        const files = Array.isArray(req.files) ? req.files : [];

        const attachments = files.map((file) => ({
            filename: file.originalname,
            path: file.path,
        }));

        try {
            const info = await sendReply(message, bodyText, attachments);
            broadcast("update", { reason: "reply-sent", id }, centralEmail);
            res.json({ sent: true, sentMessageId: info.messageId });
        } catch (error) {
            if (error instanceof AlreadyRepliedError) {
                res.status(409).json({ error: "Message already replied to" });
                return;
            }

            if (error instanceof StudentDeletedError) {
                res.status(409).json({ error: error.message });
                return;
            }

            console.error("REPLY FAILED", error);
            res.status(502).json({ error: "Failed to send reply" });
        }
    }
);

app.post("/api/messages/:id/mark-handled", requireAuth, requireCollege, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid message id" });
        return;
    }

    const centralEmail = res.locals.centralEmail;
    const message = await fetchMessageById(id, centralEmail, res.locals.collegeId);

    if (!message) {
        res.status(404).json({ error: "Message not found" });
        return;
    }

    if (message.replied) {
        res.status(409).json({ error: "Message already replied to" });
        return;
    }

    const ok = await markHandled(id, centralEmail, res.locals.collegeId);

    if (!ok) {
        res.status(409).json({ error: "Message already replied to" });
        return;
    }

    broadcast("update", { reason: "handled", id }, centralEmail);
    res.json({ handled: true });
});

const port = Number(process.env.PORT || 3001);
const fallbackSyncIntervalMs = Number(
    process.env.FALLBACK_SYNC_INTERVAL_MS || 60000
);

app.listen(port, "0.0.0.0", async () => {
    console.log(`API listening on http://127.0.0.1:${port}`);

    const mailboxes = await listCentralMailboxes();

    for (const mailbox of mailboxes) {
        ensureWatcher(mailbox.email, mailbox.password);
        triggerSync(mailbox.email, mailbox.password);
    }

    setInterval(async () => {
        const current = await listCentralMailboxes();
        for (const mailbox of current) {
            triggerSync(mailbox.email, mailbox.password);
        }
    }, fallbackSyncIntervalMs);
});

process.on("SIGINT", async () => {
    await db.end();
    process.exit(0);
});
