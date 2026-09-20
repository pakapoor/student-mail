import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

export const db = new Pool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || "student_mail",
    user: process.env.DB_USER || "student_mail_app",
    password: process.env.DB_PASSWORD || undefined,
});

export async function testDatabase() {
    const result = await db.query("SELECT NOW() AS now");
    console.log("PostgreSQL connected:", result.rows[0].now);
}
