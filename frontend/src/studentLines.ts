// Checks what a clerk typed in the Add students box, line by line, so a mistake
// is shown at once and the button stays off until it is fixed. These are the same
// rules the server applies (backend/src/autoAdd.ts); the server stays the
// authority and re-checks everything. Keep the two in step.

export const MAX_STUDENT_LINES = 10;

export interface LineError {
    // 1-based, counting every line in the box (blank ones and the header too),
    // so it matches what the clerk sees; 0 is a problem with the box as a whole.
    line: number;
    message: string;
    // The line as typed (empty for a problem with the box as a whole), so the
    // clerk can see which one to fix.
    text: string;
}

export interface StudentLine {
    // The line as typed (trimmed), name and Application No already split.
    text: string;
    name: string;
    admissionId: string;
}

export interface LineCheck {
    errors: LineError[];
    // Lines that would be sent (blank lines and a header line are not counted).
    count: number;
    // The same lines split into name and Application No; only filled in when
    // there are no errors, i.e. when the box can be sent.
    lines: StudentLine[];
}

const EXPECTED_HEADER = "student name,application no";

// A name is words made only of letters (A-Z, a-z) separated by spaces - first,
// middle and last names alike; every real student on file already looks like this.
const NAME_PATTERN = /^[A-Za-z]+( [A-Za-z]+)*$/;
const NAME_MESSAGE = "The name can only have letters (A to Z) and spaces - no numbers, dots, hyphens or other symbols";

// One line split at its commas, each part trimmed (spaces before or after the
// comma, before the name or after the number do not matter). No quote handling:
// a line has exactly one comma, between the name and the Application No.
function splitFields(line: string): string[] {
    return line.split(",").map((field) => field.trim());
}

export function checkStudentLines(text: string): LineCheck {
    // Windows (CRLF), Unix (LF) or old Mac (CR) line endings.
    const typed = text
        .split(/\r\n|\n|\r/)
        .map((content, index) => ({ content, number: index + 1 }))
        .filter(({ content }) => content.trim().length > 0);

    const first = typed[0];
    const hasHeader = first ? splitFields(first.content).join(",").toLowerCase() === EXPECTED_HEADER : false;
    const dataLines = hasHeader ? typed.slice(1) : typed;
    const errors: LineError[] = [];

    if (dataLines.length > MAX_STUDENT_LINES) {
        errors.push({
            line: 0,
            message: `Add at most ${MAX_STUDENT_LINES} students at a time (there are ${dataLines.length} lines)`,
            text: "",
        });
    }

    for (const { content, number } of dataLines) {
        const fields = splitFields(content);
        const name = (fields[0] ?? "").trim();
        const admissionId = (fields[1] ?? "").trim();

        if (fields.length < 2) {
            errors.push({ line: number, message: "Put a comma between the name and the Application No, like Jane Doe,10012345", text: content.trim() });
        } else if (fields.length > 2) {
            errors.push({ line: number, message: "Use only one comma, between the name and the Application No", text: content.trim() });
        } else if (!name) {
            errors.push({ line: number, message: "The student name is missing", text: content.trim() });
        } else if (!NAME_PATTERN.test(name.replace(/\s+/g, " "))) {
            errors.push({ line: number, message: NAME_MESSAGE, text: content.trim() });
        } else if (!admissionId) {
            errors.push({ line: number, message: "The Application No is missing", text: content.trim() });
        } else if (!/^\d+$/.test(admissionId) || !/[1-9]/.test(admissionId)) {
            errors.push({ line: number, message: `The Application No must be a whole number, digits only (got "${admissionId}")`, text: content.trim() });
        }
    }

    const lines: StudentLine[] =
        errors.length > 0
            ? []
            : dataLines.map(({ content }) => {
                  const fields = splitFields(content);
                  return {
                      text: content.trim(),
                      name: (fields[0] ?? "").replace(/\s+/g, " ").trim(),
                      admissionId: (fields[1] ?? "").trim(),
                  };
              });

    return { errors, count: dataLines.length, lines };
}
