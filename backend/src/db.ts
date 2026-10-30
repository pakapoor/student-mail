import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

// Step 53: no database call may wait forever (a stuck call froze a whole job
// before), and a connection closed by PostgreSQL (Ubuntu's automatic updates
// restart it) must not crash the process - it did on 2026-10-02, 10-09, 10-23.
export const DB_CONNECT_TIMEOUT_MS = 10000;
export const DB_QUERY_TIMEOUT_MS = 30000;

export function poolOptions(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
    return {
        host: env.DB_HOST || "127.0.0.1",
        port: Number(env.DB_PORT || 5432),
        database: env.DB_NAME || "student_mail",
        user: env.DB_USER || "student_mail_app",
        password: env.DB_PASSWORD || undefined,
        // Waiting for a free connection from the pool, or for a new one.
        connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
        // Client side: gives up on a query whose answer never comes (network).
        query_timeout: DB_QUERY_TIMEOUT_MS,
        // Server side: PostgreSQL cancels a query running longer than this.
        statement_timeout: DB_QUERY_TIMEOUT_MS,
    };
}

// An idle connection that PostgreSQL closes emits 'error' on the pool; without
// a listener Node treats it as fatal. Log it; the pool opens a fresh
// connection for the next query.
export function onPoolError(error: Error): void {
    console.error("[db] idle connection error (the pool reconnects on the next query):", error.message);
}

export const db = new Pool(poolOptions());
db.on("error", onPoolError);

export async function testDatabase() {
    const result = await db.query("SELECT NOW() AS now");
    console.log("PostgreSQL connected:", result.rows[0].now);
}
