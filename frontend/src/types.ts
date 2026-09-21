export interface College {
    id: string;
    name: string;
}

export interface Session {
    email: string;
    college: College;
}

export interface ThreadSummary {
    threadId: number;
    subject: string | null;
    student_email: string;
    sender_email: string;
    received_at: string;
    message_count: number;
    pending_count: number;
}

export type StatusFilter = "pending" | "replied";

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
    college: string | null;
    year_enrolled: number | null;
    central_email: string | null;
    created_at: string;
    deleted_at: string | null;
}

export interface AdminStudentPage {
    students: AdminStudentRow[];
    nextCursor: string | null;
}

export interface RejectedRow {
    line: number;
    email: string;
    reason: string;
    owner?: string;
}

export interface ImportResult {
    imported: number;
    updated: number;
    rejected: RejectedRow[];
}
