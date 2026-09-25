// One date/time format everywhere in the console (Step 18 refresh):
// "25 Sep, 7:39 AM" - short, unambiguous, same in the list, the thread,
// the boxes and Manage students. Built by hand so every browser/locale
// shows exactly the same text.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDateTime(iso: string | Date): string {
    const d = new Date(iso);

    if (Number.isNaN(d.getTime())) {
        return "";
    }

    const hours = d.getHours();
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    const minutes = String(d.getMinutes()).padStart(2, "0");

    return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${h12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

// Edugate's own "25.09.2026 08:09" (reviewer's local time, no timezone) →
// "25 Sep 2026, 08:09", shown as-is without converting timezones.
export function edugateDate(text: string): string {
    const m = text.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2})$/);

    if (!m) {
        return text;
    }

    const [, day, month, year, time] = m;
    return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}, ${time}`;
}
