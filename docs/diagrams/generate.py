#!/usr/bin/env python3
"""Draws the diagrams used by README.md as plain SVG files (no dependencies).

    python3 docs/diagrams/generate.py

Every diagram has its own white background, so it looks the same on GitHub's
light and dark themes. Edit the drawings here and run the script; the .svg
files next to it are the output and are committed so GitHub can show them.
To look at one outside a browser: resvg -w 1400 docs/diagrams/x.svg x.png
"""
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).parent

INK = "#16213a"
MUTED = "#5b6478"
LINE = "#8a94a8"
BLUE = "#1f4fb8"
BLUE_SOFT = "#e9effc"
GREEN = "#15803d"
GREEN_SOFT = "#e7f5ec"
AMBER = "#a15c00"
AMBER_SOFT = "#fff4dc"
RED = "#c2352f"
RED_SOFT = "#fdeeed"
GREY_SOFT = "#f3f5f9"
FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"


class Svg:
    def __init__(self, width, height, title, description):
        self.w, self.h = width, height
        self.title, self.description = title, description
        self.parts = []

    def raw(self, s):
        self.parts.append(s)

    def text(self, x, y, lines, size=14, anchor="middle", weight="400", fill=INK, gap=1.28):
        if isinstance(lines, str):
            lines = [lines]
        spans = "".join(
            f'<tspan x="{x}" dy="{0 if i == 0 else round(size * gap, 1)}">{escape(line)}</tspan>'
            for i, line in enumerate(lines)
        )
        self.raw(f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" font-weight="{weight}" fill="{fill}">{spans}</text>')

    def box(self, x, y, w, h, title=None, lines=(), fill=GREY_SOFT, stroke=LINE, rx=10, size=13, title_size=14):
        self.raw(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        block = (title_size * 1.28 if title else 0) + len(lines) * size * 1.28
        cy = y + (h - block) / 2 + (title_size if title else size) * 0.9
        if title:
            self.text(x + w / 2, cy, title, size=title_size, weight="700")
            cy += title_size * 1.28
        if lines:
            self.text(x + w / 2, cy, list(lines), size=size, fill=MUTED)

    def group(self, x, y, w, h, title):
        self.raw(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="none" stroke="{LINE}" stroke-width="1.5" stroke-dasharray="7 5"/>')
        self.text(x + 16, y + 24, title, size=13, anchor="start", weight="700", fill=MUTED)

    def db(self, x, y, w, h, title, lines=(), fill=BLUE_SOFT, stroke=BLUE):
        ry = 9
        self.raw(f'<path d="M{x} {y+ry} v{h-2*ry} a{w/2} {ry} 0 0 0 {w} 0 v{-(h-2*ry)}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        self.raw(f'<ellipse cx="{x+w/2}" cy="{y+ry}" rx="{w/2}" ry="{ry}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        block = 14 * 1.28 + len(lines) * 12 * 1.28
        top = y + ry * 2 + (h - ry * 3 - block) / 2 + 12
        self.text(x + w / 2, top, title, size=14, weight="700")
        if lines:
            self.text(x + w / 2, top + 14 * 1.28, list(lines), size=12, fill=MUTED)

    def diamond(self, cx, cy, w, h, lines, fill=AMBER_SOFT, stroke=AMBER):
        self.raw(f'<polygon points="{cx},{cy-h/2} {cx+w/2},{cy} {cx},{cy+h/2} {cx-w/2},{cy}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        self.text(cx, cy - (len(lines) - 1) * 8 + 4, lines, size=13, weight="600")

    def arrow(self, points, label=None, dashed=False, color=LINE, label_at=None, both=False, label_w=None):
        d = "M" + " L".join(f"{x} {y}" for x, y in points)
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        start = ' marker-start="url(#arrow-start)"' if both else ""
        self.raw(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.8"{dash} marker-end="url(#arrow)"{start}/>')
        if label:
            if label_at is None:
                (x1, y1), (x2, y2) = points[0], points[-1]
                label_at = ((x1 + x2) / 2, (y1 + y2) / 2)
            lx, ly = label_at
            lines = label if isinstance(label, list) else [label]
            width = label_w or (max(len(t) for t in lines) * 6.6 + 12)
            height = len(lines) * 16 + 6
            self.raw(f'<rect x="{lx-width/2}" y="{ly-height/2}" width="{width}" height="{height}" rx="5" fill="#ffffff" fill-opacity="0.94"/>')
            self.text(lx, ly - (len(lines) - 1) * 8 + 4, lines, size=12, fill=MUTED, gap=1.3)

    def badge(self, cx, cy, n, fill=BLUE):
        self.raw(f'<circle cx="{cx}" cy="{cy}" r="13" fill="{fill}"/>')
        self.text(cx, cy + 5, str(n), size=13, weight="700", fill="#ffffff")

    def render(self):
        head = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" '
            f'font-family="{FONT}" role="img" aria-labelledby="t d">\n'
            f'<title id="t">{escape(self.title)}</title><desc id="d">{escape(self.description)}</desc>\n'
            '<defs>'
            f'<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{LINE}"/></marker>'
            f'<marker id="arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M10 0 L0 5 L10 10 z" fill="{LINE}"/></marker>'
            '</defs>\n'
            f'<rect width="{self.w}" height="{self.h}" fill="#ffffff"/>\n'
            f'<rect x="0.75" y="0.75" width="{self.w-1.5}" height="{self.h-1.5}" rx="14" fill="none" stroke="#e3e7ef"/>\n'
        )
        return head + "\n".join(self.parts) + "\n</svg>\n"

    def save(self, name):
        (OUT / name).write_text(self.render(), encoding="utf-8")
        print("wrote", name)


# ----------------------------------------------------------------------------
def architecture():
    s = Svg(1080, 560, "System overview", "Edugate, parents and Migadu feed the central mailbox; the API on one EC2 server syncs it into PostgreSQL and serves the staff console; nightly backups go to S3.")
    s.text(540, 34, "The big picture", size=20, weight="700")

    s.group(24, 60, 336, 470, "Outside services")
    s.box(44, 100, 140, 116, "Edugate portal", ["verification", "codes, logins,", "rejections"], fill=AMBER_SOFT, stroke=AMBER)
    s.box(200, 100, 140, 116, "Parents", ["and students:", "ordinary mail"], fill=GREY_SOFT)
    s.box(44, 340, 296, 150, "Migadu", ["a mailbox per student,", "forwarding to one", "central mailbox"], fill=BLUE_SOFT, stroke=BLUE)
    s.arrow([(114, 216), (114, 340)])
    s.arrow([(270, 216), (270, 340)])

    s.group(520, 60, 300, 470, "One EC2 server")
    s.box(540, 100, 260, 76, "nginx", ["TLS + the static React console"])
    s.box(540, 236, 260, 108, "Node / Express API", ["mail sync, threads, roster,", "replies, background jobs", "(backend/src)"], fill=BLUE_SOFT, stroke=BLUE)
    s.db(570, 396, 200, 100, "PostgreSQL", ["students, messages,", "thread summaries"])

    s.box(880, 100, 176, 92, "Staff browser", ["the console", "(React + Vite)"], fill=GREEN_SOFT, stroke=GREEN)
    s.db(880, 396, 176, 100, "S3", ["nightly backups,", "encrypted with gpg"], fill=GREY_SOFT, stroke=LINE)

    s.arrow([(340, 384), (420, 384), (420, 290), (540, 290)], ["IMAP IDLE", "+ sync"], label_at=(420, 338), label_w=76)
    s.arrow([(540, 322), (470, 322), (470, 448), (340, 448)], ["read one student's", "mailbox; send replies"], dashed=True, label_at=(470, 416), label_w=130)
    s.arrow([(880, 138), (800, 138)], "HTTPS", label_at=(840, 124), label_w=50)
    s.arrow([(670, 176), (670, 236)])
    s.arrow([(670, 344), (670, 396)], both=True)
    s.arrow([(800, 290), (968, 290), (968, 192)], ["live updates", "(server-sent events)"], dashed=True, label_at=(884, 290), label_w=134)
    s.arrow([(770, 446), (880, 446)], ["pg_dump + gpg", "+ cron"], dashed=True, label_at=(825, 420), label_w=100)
    s.save("architecture.svg")


def mail_flow():
    s = Svg(1000, 480, "How mail gets into the console", "Six steps from a forwarded email to a live update in every console, with three safety nets for mail that never reaches the central mailbox.")
    s.text(500, 34, "How mail gets into the console", size=20, weight="700")
    cards = [
        ("Mail arrives", ["Migadu forwards each", "student's mail to the", "central mailbox"]),
        ("Sync wakes", ["an IDLE \"new mail\" push,", "or the 5-second", "fallback poll"]),
        ("Fetch", ["only UIDs newer than", "the saved place", "(last_uid)"]),
        ("Match and store", ["To: addresses matched to", "our students; one row", "per student; repeats ignored"]),
        ("Edugate email?", ["a code, login or rejection", "updates the student's", "status as it is stored"]),
        ("Announce", ["the new place is saved and", "every console is told;", "only the colleges concerned chime"]),
    ]
    xs = [40, 360, 680]
    ys = [76, 236]
    for i, (title, lines) in enumerate(cards):
        x, y = xs[i % 3], ys[i // 3]
        accent, soft = (AMBER, AMBER_SOFT) if i == 4 else (BLUE, BLUE_SOFT)
        s.box(x, y, 280, 110, title, lines, fill=soft, stroke=accent)
        s.badge(x + 24, y + 24, i + 1, fill=accent)
    s.arrow([(320, 131), (360, 131)])
    s.arrow([(640, 131), (680, 131)])
    s.arrow([(820, 186), (820, 211), (180, 211), (180, 236)])
    s.arrow([(320, 291), (360, 291)])
    s.arrow([(640, 291), (680, 291)])

    s.box(40, 380, 920, 80, None, [], fill=GREEN_SOFT, stroke=GREEN)
    s.text(500, 410, "When an email never reaches the central mailbox, three safety nets read the student's OWN mailbox:", size=14, weight="700")
    s.text(500, 438, "the console search  ·  the daily sweep (about 2,300 mailboxes a day)  ·  the hot list after a code (every 30 s, then 2 min)", size=13, fill=MUTED)
    s.save("mail-flow.svg")


def edugate_status():
    s = Svg(1000, 500, "A student's Edugate status", "The latest Edugate email decides: no mail, code live, code expired, registered or rejected, and which email moves a student between them.")
    s.text(500, 34, "What a student's Edugate status means", size=20, weight="700")
    s.text(500, 58, "The latest Edugate email decides", size=13, fill=MUTED)

    s.box(30, 190, 170, 80, "No Edugate mail", ["shows as “—”"], fill=GREY_SOFT)
    s.box(300, 90, 190, 84, "Code live", ["a code arrived", "in the last 30 min"], fill=BLUE_SOFT, stroke=BLUE)
    s.box(300, 300, 190, 84, "Code expired", ["older than 30 min,", "not registered"], fill=AMBER_SOFT, stroke=AMBER)
    s.box(620, 190, 190, 84, "Registered", ["login + password", "received"], fill=GREEN_SOFT, stroke=GREEN)
    s.box(790, 340, 180, 84, "Rejected", ["a document was", "rejected"], fill=RED_SOFT, stroke=RED)

    s.arrow([(200, 218), (300, 150)], "code email", label_at=(240, 168), label_w=80)
    s.arrow([(395, 174), (395, 300)], "30 minutes pass", label_at=(395, 237), label_w=112)
    s.arrow([(490, 132), (620, 210)], "login email", label_at=(570, 152), label_w=82)
    s.arrow([(490, 342), (620, 254)], "login email", label_at=(570, 322), label_w=82)
    s.arrow([(330, 300), (330, 174)], None)
    s.text(322, 246, "new code", size=12, fill=MUTED, anchor="end")
    s.arrow([(715, 190), (715, 132), (490, 116)], ["another code", "requested"], label_at=(690, 134), label_w=96)
    s.arrow([(760, 274), (850, 340)], "document rejected", label_at=(852, 306), label_w=120)
    s.arrow([(790, 396), (700, 396), (700, 274)], "newer login", label_at=(690, 410), label_w=84)

    s.text(30, 452, "A newer code or login email always overrides an older rejection.", size=12, anchor="start", fill=MUTED)
    s.text(30, 474, "The console list and the Students dialog use the same rule, so the buttons (Code received, Code expired, Registered, Rejected) always agree.", size=12, anchor="start", fill=MUTED)
    s.save("edugate-status.svg")


def thread_summaries():
    s = Svg(1000, 610, "How the console list is built", "Writes queue the student in thread_dirty; the summaries are rebuilt per student into thread_summaries; LIST_MODE picks the old list, a shadow comparison or the stored list.")
    s.text(500, 34, "How the console list is built (Step 32)", size=20, weight="700")

    s.box(30, 70, 200, 84, "Any write", ["the app, a script,", "or manual SQL"], fill=GREY_SOFT)
    s.box(280, 70, 200, 84, "Database triggers", ["on messages, replies", "and student columns"], fill=AMBER_SOFT, stroke=AMBER)
    s.db(530, 62, 190, 100, "thread_dirty", ["students to rebuild"])
    s.box(770, 70, 200, 84, "Rebuild", ["before every list read", "and every 2 s"], fill=BLUE_SOFT, stroke=BLUE)
    s.arrow([(230, 112), (280, 112)])
    s.arrow([(480, 112), (530, 112)])
    s.arrow([(720, 112), (770, 112)])

    s.box(770, 210, 200, 96, "buildSummaries()", ["the same grouping and", "badge code as the old", "list, one student at a time"], fill=BLUE_SOFT, stroke=BLUE)
    s.db(530, 208, 190, 100, "thread_summaries", ["one row per thread"])
    s.arrow([(870, 154), (870, 210)])
    s.arrow([(770, 258), (720, 258)])
    s.box(30, 214, 440, 96, "Kept honest", ["an hourly check rebuilds 100 random students", "in memory and compares them with what is stored;", "a difference is logged and the student is queued again"], fill=GREEN_SOFT, stroke=GREEN, size=12)
    s.arrow([(470, 262), (530, 262)], dashed=True, color=GREEN)
    s.arrow([(625, 208), (625, 162)], "queue again", dashed=True, color=GREEN, label_at=(625, 185), label_w=84)

    s.group(30, 350, 940, 224, "GET /api/threads : the LIST_MODE setting picks the source")
    s.arrow([(625, 308), (625, 350)], color=BLUE)
    s.text(640, 337, "shadow and table read these rows", size=12, anchor="start", fill=MUTED)
    s.box(56, 392, 264, 122, "legacy (the default)", ["reads every message of the", "mailbox, groups the threads", "in Node, then cuts 25 rows"], fill=GREY_SOFT)
    s.box(368, 392, 264, 122, "shadow", ["answers with the legacy list,", "also reads the stored one and", "logs every difference"], fill=AMBER_SOFT, stroke=AMBER)
    s.box(680, 392, 264, 122, "table", ["one indexed query with LIMIT", "and one grouped count;", "any error falls back to legacy"], fill=BLUE_SOFT, stroke=BLUE)
    s.text(500, 552, "Rollback is one setting (LIST_MODE=legacy) and a restart.", size=13, fill=MUTED)
    s.save("thread-summaries.svg")


def data_model():
    s = Svg(1040, 720, "Data model", "The tables and how they are linked: colleges, students, messages, replies, thread summaries, the rebuild queue, sessions, central mailboxes.")
    s.text(520, 34, "Data model", size=20, weight="700")
    s.text(520, 56, "Linked by email address (always lower case: a trigger and a CHECK enforce it), except the foreign keys marked FK", size=12, fill=MUTED)

    def table(x, y, w, name, cols, accent=BLUE, soft=BLUE_SOFT):
        h = 34 + len(cols) * 20 + 10
        s.raw(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="#ffffff" stroke="{accent}" stroke-width="1.6"/>')
        s.raw(f'<path d="M{x} {y+34} v-24 a10 10 0 0 1 10 -10 h{w-20} a10 10 0 0 1 10 10 v24 z" fill="{soft}" stroke="{accent}" stroke-width="1.6"/>')
        s.text(x + w / 2, y + 23, name, size=14, weight="700")
        for i, (col, kind) in enumerate(cols):
            cy = y + 34 + 18 + i * 20
            s.text(x + 14, cy, col, size=12, anchor="start")
            s.text(x + w - 12, cy, kind, size=11, anchor="end", fill=MUTED)
        return y + h

    C1, C2, C3, W = 30, 395, 770, 240
    table(C1, 90, W, "sessions", [("token_hash", "PK"), ("email", ""), ("college_id", "FK"), ("expires_at", "")])
    colleges_bottom = table(C2, 90, W, "colleges", [("id", "PK"), ("name", "unique")], accent=GREEN, soft=GREEN_SOFT)
    table(C3, 90, W, "thread_summaries", [("thread_id", "PK"), ("student_email", ""), ("college_id", "FK"), ("badge", ""), ("received_at", "")])
    messages_bottom = table(C1, 290, W, "messages", [("message_id", "unique with student"), ("student_email", ""), ("central_email", ""), ("edugate_kind", "code/login/rejected"), ("replied", "")])
    students_bottom = table(C2, 290, W, "students", [("email", "unique"), ("college_id", "FK"), ("admission_id", "unique per college"), ("central_email", ""), ("code_sent_at", ""), ("registered_at", ""), ("rejected_at", ""), ("deleted_at", "soft delete")])
    table(C3, 290, W, "thread_dirty", [("student_email", "PK"), ("marked_at", "")], accent=AMBER, soft=AMBER_SOFT)
    table(C1, 540, W, "central_mailboxes", [("email", "PK"), ("last_uid", "the saved place"), ("uid_validity", "")], accent=AMBER, soft=AMBER_SOFT)
    table(C2, 570, W, "replies", [("incoming_message_id", ""), ("student_email", ""), ("sent_at", "")])
    table(C3, 540, W, "status_problems", [("kind, subject", "one open row"), ("detail, times", ""), ("solved_at", "")], accent=LINE, soft=GREY_SOFT)

    mid1, mid2 = (C1 + W + C2) / 2, (C2 + W + C3) / 2
    s.arrow([(C1 + W, 107), (C2, 107)], "FK", label_at=(mid1, 95), label_w=30, both=True)
    s.arrow([(C2 + W, 107), (C3, 107)], "FK", label_at=(mid2, 95), label_w=30, both=True)
    s.arrow([(C2 + W / 2, colleges_bottom), (C2 + W / 2, 290)], "FK", label_at=(C2 + W / 2, (colleges_bottom + 290) / 2), label_w=30, both=True)
    s.arrow([(C2, 307), (C1 + W, 307)], "student_email", label_at=(mid1, 295), label_w=104, both=True)
    s.arrow([(C2 + W, 307), (C3, 307)], "queued", label_at=(738, 295), label_w=52)
    s.arrow([(C2 + W, 360), (690, 360), (690, 200), (C3, 200)], "rebuilt from", label_at=(690, 240), label_w=86, dashed=True)
    s.arrow([(C2 + W / 2, students_bottom), (C2 + W / 2, 570)], "student_email", label_at=(C2 + W / 2, (students_bottom + 570) / 2), label_w=104, both=True)
    s.arrow([(C1 + W / 2, messages_bottom), (C1 + W / 2, 540)], "central_email", label_at=(C1 + W / 2, (messages_bottom + 540) / 2), label_w=98, both=True)
    s.save("data-model.svg")


def authorization():
    s = Svg(1000, 430, "Who may see what", "Every request needs a session, then a chosen college; every query is limited to the session's mailbox and college and to active students.")
    s.text(500, 34, "Who may see what", size=20, weight="700")
    s.text(30, 76, "Staff share one login per central mailbox, so the Students dialog lists", size=13, anchor="start", fill=MUTED)
    s.text(30, 96, "every college of that mailbox, read-only; the console's threads are per college.", size=13, anchor="start", fill=MUTED)

    s.box(30, 190, 130, 60, "Request", [], fill=GREY_SOFT)
    s.diamond(290, 220, 190, 116, ["Signed in?", "session cookie"])
    s.diamond(560, 220, 190, 116, ["College", "chosen?"])
    s.box(760, 188, 210, 64, "Scoped query", ["this mailbox and college,", "active students only"], fill=BLUE_SOFT, stroke=BLUE, size=12)
    s.arrow([(160, 220), (195, 220)])
    s.arrow([(385, 220), (465, 220)], "yes", label_at=(425, 208), label_w=34)
    s.arrow([(655, 220), (760, 220)], "yes", label_at=(707, 208), label_w=34)
    s.box(210, 338, 160, 56, "401", ["not authenticated"], fill=RED_SOFT, stroke=RED)
    s.box(480, 338, 160, 56, "400", ["Select a college"], fill=RED_SOFT, stroke=RED)
    s.arrow([(290, 278), (290, 338)], "no", label_at=(304, 308), label_w=32)
    s.arrow([(560, 278), (560, 338)], "no", label_at=(574, 308), label_w=32)
    s.box(760, 100, 210, 56, "200", ["your own college's data"], fill=GREEN_SOFT, stroke=GREEN, size=12)
    s.arrow([(865, 188), (865, 156)])
    s.box(760, 322, 210, 92, "404", ["another college or mailbox,", "or a deleted student:", "as if it did not exist"], fill=AMBER_SOFT, stroke=AMBER, size=12)
    s.arrow([(865, 252), (865, 322)])
    s.save("authorization.svg")


def tests():
    s = Svg(1000, 520, "How the tests run", "node --test starts one process per test file in parallel; each database test file gets its own throwaway PostgreSQL on its own port, deleted afterwards.")
    s.text(500, 34, "How the tests run", size=20, weight="700")

    s.box(30, 220, 170, 80, "npm run check", ["before every check-in"], fill=GREEN_SOFT, stroke=GREEN)
    s.box(250, 220, 190, 80, "node --test", ["one process per test", "file, in parallel"], fill=BLUE_SOFT, stroke=BLUE)
    s.arrow([(200, 260), (250, 260)])

    files = [("threadSummaries.db.test", 78), ("server.http.test", 168), ("sync.db.test", 258), ("roster.db.test  …", 348)]
    for name, y in files:
        s.box(500, y, 210, 58, name, [], fill=GREY_SOFT, title_size=12)
        s.db(770, y - 12, 190, 84, "own PostgreSQL", ["own folder, own port"])
        s.arrow([(710, y + 29), (770, y + 29)])
        s.arrow([(440, 260), (470, 260), (470, y + 29), (500, y + 29)])
    s.box(500, 438, 210, 58, "edugate.test  units.test  …", [], fill=GREY_SOFT, title_size=12)
    s.text(865, 470, "no database needed", size=12, fill=MUTED)
    s.arrow([(440, 260), (470, 260), (470, 467), (500, 467)])
    s.arrow([(710, 467), (770, 467)], dashed=True)
    s.text(30, 380, "Each database file resets its tables between its own tests;", size=12, anchor="start", fill=MUTED)
    s.text(30, 398, "nothing is shared between files, and the development and", size=12, anchor="start", fill=MUTED)
    s.text(30, 416, "production databases are never touched.", size=12, anchor="start", fill=MUTED)
    s.text(30, 446, "queryplans.db.test also runs EXPLAIN on the hottest", size=12, anchor="start", fill=MUTED)
    s.text(30, 464, "queries and fails if any table is still scanned.", size=12, anchor="start", fill=MUTED)
    s.save("tests.svg")


if __name__ == "__main__":
    architecture()
    mail_flow()
    edugate_status()
    thread_summaries()
    data_model()
    authorization()
    tests()
