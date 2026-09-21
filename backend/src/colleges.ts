import { db } from "./db.js";

export interface College {
    id: string;
    name: string;
}

export async function listColleges(): Promise<College[]> {
    const result = await db.query<College>("SELECT id, name FROM colleges ORDER BY id");
    return result.rows;
}

export async function findCollege(id: string): Promise<College | undefined> {
    const result = await db.query<College>("SELECT id, name FROM colleges WHERE id = $1", [id]);
    return result.rows[0];
}
