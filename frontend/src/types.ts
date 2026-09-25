export interface College {
    id: string;
    name: string;
}

export interface Session {
    email: string;
    college: College | null;
}

export interface ThreadSummary {
    threadId: number;
    subject: string | null;
    student_email: string;
    sender_email: string;
    received_at: string;
    message_count: number;
    pending_count: number;
    preview: string;
    registered: boolean;
    // The one badge the list shows (backend thread.ts threadBadge).
    badge: "registered" | "rejected" | "code" | "used" | "new" | "replied";
    code_at: string | null;
    student_name: string | null;
}

// "all" = the tab-less list (Step 18 phase 2); the others are kept for
// compatibility.
export type StatusFilter = "pending" | "replied" | "all";

export interface IncomingThreadItem {
    type: "incoming";
    id: number;
    message_id: string;
    student_email: string;
    sender_email: string;
    subject: string | null;
    at: string;
    replied: boolean;
    replied_at: string | null;
    body_text: string | null;
    body_html: string | null;
    handled_without_reply: boolean;
    // Step 18 phase 2 (backend thread.ts): a verification code superseded by
    // a later registration; and, on registration emails only, the time of a
    // newer registration / newer unrecognised Edugate email (the password
    // here may be outdated).
    auto_closed: boolean;
    newer_login_at: string | null;
    newer_edugate_at: string | null;
}

export interface OutgoingThreadItem {
    type: "outgoing";
    id: number;
    incoming_message_id: string;
    student_email: string;
    recipient_email: string;
    sent_message_id: string | null;
    at: string;
    attachment_count: number;
    body_text: string | null;
    body_html: string | null;
}

export type ThreadItem = IncomingThreadItem | OutgoingThreadItem;

export interface StudentRow {
    id: number;
    name: string | null;
    email: string;
    created_at: string;
}

export interface AdminStudentRow {
    id: number;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    email: string;
    admission_id: string | null;
    year_enrolled: number | null;
    created_at: string;
    deleted_at: string | null;
    // Edugate registration status - see backend registrationStatus.ts.
    registration_status: "REGISTRATION_PENDING" | "REGISTERED" | null;
    code_sent_at: string | null;
    registered_at: string | null;
}

export interface AdminStudentPage {
    students: AdminStudentRow[];
    nextCursor: string | null;
}

export interface RejectedRow {
    line: number;
    email: string;
    reason: string;
}

export interface ImportResult {
    imported: number;
    skipped: number;
    rejected: RejectedRow[];
}
