import { shortDateTime } from "./format";
import type { AdminStudentRow } from "./types";

// Step 51: the Search students list as a CSV file (Save CSV button). Columns as
// on screen; never a password.
export const STUDENTS_CSV_HEADER = ["Name", "Email", "Application No", "College", "Year enrolled", "Edugate status"];

export function displayName(s: AdminStudentRow): string {
    const combined = [s.first_name, s.last_name].filter(Boolean).join(" ");
    return combined || s.name || "(no name)";
}

// The Edugate status cell as text, same wording as the list (ManageStudents.tsx RegistrationStatus).
export function edugateStatusText(s: AdminStudentRow): string {
    const registeredNote = s.registered_at && s.edugate_state !== "registered" ? `; registered ${shortDateTime(s.registered_at)}` : "";

    switch (s.edugate_state) {
        case "rejected":
            return `Rejected - ${shortDateTime(s.rejected_at!)}${registeredNote}`;
        case "registered":
            return `Registered - ${shortDateTime(s.registered_at!)}`;
        case "code_live":
        case "code_expired":
            return `${s.edugate_state === "code_live" ? "Code received" : "Code expired"} - ${shortDateTime(s.code_sent_at!)}${registeredNote}`;
        default:
            return "";
    }
}

// Quoted only when needed (comma, quote or line break); quotes doubled.
function csvValue(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// With a byte order mark, so Excel reads it as UTF-8.
export function studentsCsv(rows: AdminStudentRow[]): string {
    const lines = rows.map((s) =>
        [displayName(s), s.email, s.admission_id ?? "", s.college_name ?? "", s.year_enrolled == null ? "" : String(s.year_enrolled), edugateStatusText(s)]
            .map(csvValue)
            .join(",")
    );

    return "﻿" + [STUDENTS_CSV_HEADER.join(","), ...lines].join("\r\n") + "\r\n";
}

// e.g. students-KYRGYZ-NATIONAL-UNIVERSITY-2026-10-21.csv
export function studentsCsvFileName(collegeName: string | null, now = new Date()): string {
    const place = (collegeName ?? "all colleges").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "students";
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return `students-${place}-${date}.csv`;
}
