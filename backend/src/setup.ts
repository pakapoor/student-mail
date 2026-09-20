import { db, testDatabase } from "./db.js";

async function main() {
    await testDatabase();

    const students = [
        ["Test Student 11", "test.student11@pilot.system-design.in", "password"],
        ["Test Student 12", "test.student12@pilot.system-design.in", "password"],
        ["Test Student 13", "test.student13@pilot.system-design.in", "password"],
    ];

    for (const [name, email, password] of students) {
        await db.query(
            `
            INSERT INTO students (name, email, smtp_password)
            VALUES ($1, $2, $3)
            ON CONFLICT (email)
            DO UPDATE SET
                name = EXCLUDED.name,
                smtp_password = EXCLUDED.smtp_password
            `,
            [name, email, password]
        );

        console.log("Student ready:", email);
    }

    const result = await db.query(
        "SELECT id, name, email FROM students ORDER BY id"
    );

    console.log("\nStudents in database:");

    for (const row of result.rows) {
        console.log(row.id, row.name, row.email);
    }

    await db.end();
}

main().catch((err) => {
    console.error("SETUP FAILED:");
    console.error(err);
    process.exit(1);
});
