# Student Mail Console

Handoff/reference doc for anyone (human or AI assistant) picking this project
up cold, mid-stream. If you're an AI continuing this work, read this whole
file before touching anything - it captures decisions and constraints that
aren't visible from the code alone.

## What this is

A client manages ~1600 students traveling to Kyrgyzstan. The Kyrgyzstan
government requires an individual email address per student. This app gives
each student a real mailbox, retains their incoming mail, and lets a small
number of office operators reply **as** each individual student from one
central console - while keeping every conversation in the original email
thread as the government/external sender sees it.

Core requirements (from the original client brief):
- ~1600 real temporary student mailboxes on a custom domain, ~3 months of use
- Incoming mail retained per-student AND forwarded to a central operational
  mailbox; operators work from the central system
- Replies sent **from** the individual student's address, staying in the
  original Gmail/email thread (correct In-Reply-To/References), BCCing the
  central mailbox
- Multiple attachments supported
- **Reply state is tracked per individual incoming Message-ID, not per
  thread.** If a government sender replies again in the same thread, that new
  message starts out unreplied even though earlier messages in the same
  thread were already answered. Thread != unit of work. Only mark a message
  replied after SMTP send actually succeeds.
- No SMS requirement, no separate admin role - a handful of trusted office
  clerks share one console

## Stack

```
React + TypeScript (frontend/)
        |  REST API
        v
Node.js + TypeScript + Express (backend/)
        |
        +-- IMAP (imapflow)  -> central mailbox(es)
        +-- SMTP (nodemailer) -> Migadu, authenticated per-student
        +-- PostgreSQL (pg)
```

Chosen deliberately: Node/TS over FastAPI (Python was proof-of-concept only,
never the real app). No Kafka/Redis/microservices/queueing - this is
intentionally a simple app for the scale involved (1600 students, ~3 months).

## Email provider setup

- Student domain: `pilot.system-design.in` (Migadu). Main domain
  `system-design.in` is managed at GoDaddy; Migadu DNS (MX/SPF/DKIM/DMARC) is
  already configured and working.
- Migadu SMTP: `smtp.migadu.com:465` (SSL), auth = full student email +
  that student's own Migadu mailbox password (stored in `students` table,
  never in `.env`).
- Central mailbox(es): the app is now **multi-operator** - any number of real
  mailboxes can log in as a "central mailbox" (auth = a live IMAP login
  against that mailbox's real credentials, see `backend/src/auth.ts`). There
  is no separate operator password/account system; the mailbox login *is*
  the operator identity. Example central mailbox used in testing:
  `pankaj@system-design.in` (hosted at GoDaddy/Titan, IMAP
  `imap.secureserver.net:993`).
- Each student's Migadu mailbox has an external forwarding rule to a central
  mailbox. **Important discovery**: Migadu forwarding rules require the
  forwarding *target* to click a confirmation link before that mailbox's
  mail actually starts flowing - and this is required **per mailbox**, not
  once per target address. Confirmed by testing: creating forwarding for 5
  new students required 5 separate confirmation clicks even though the
  target (`pankaj@system-design.in`) had confirmed forwarding from earlier
  students already. Budget for this at 1600-student scale - it does not
  auto-skip on a known target.

### Migadu API (mailbox provisioning) - status: blocked, not wired up yet

Attempted to automate mailbox creation via Migadu's REST API
(`https://api.migadu.com/v1/domains/{domain}/mailboxes`, HTTP Basic Auth with
account email + a dedicated API key from **My Account > API Keys** - the
regular login password does NOT work for the API, confirmed against their
docs). Hit a hard blocker: `403 "mailbox limit reached for unverified
accounts, please contact support!"`. This is a Migadu-account-level
restriction, not something fixable in code - requires Migadu support to
verify the account. `MIGADU_API_KEY` and `MIGADU_ADMIN_EMAIL` are already in
`backend/.env` (gitignored) for whenever this is revisited. **Nothing in the
codebase currently calls this API** - mailbox provisioning is still 100%
manual via Migadu's own CSV import (`Name,Address,Password,InviteEmail,
ForwardEmail,ExpirationDate,RemoveUponExpiration`, no header, ~100
mailboxes/import, documented at migadu.com) done separately from this app's
own `students` import.

## Database

See `backend/schema.sql` for the authoritative recreate-from-scratch schema
(dumped from the live DB and hand-annotated - **written but not yet verified
against a fresh empty database**; do that before relying on it, e.g. after
the demo this file was written for). Tables: `students`, `messages`,
`replies`, `central_mailboxes`. Requires the `pg_trgm` extension.

Local demo setup: PostgreSQL 16 in WSL, DB `student_mail`, app user
`student_mail_app`, **localhost trust auth** configured in
`/etc/postgresql/16/main/pg_hba.conf` (`host student_mail student_mail_app
127.0.0.1/32 trust`) scoped to the `student_mail` database specifically -
trust auth does NOT apply to other databases on the same Postgres instance
(learned the hard way: `createdb` for a different DB name hangs forever
prompting for a password that never comes). This is demo-only; production
needs real DB auth/secrets.

### Key schema decisions worth knowing

- `students.central_email` is **not a tenant boundary** - it just records
  which operator/mailbox currently handles that student's mail. The admin
  roster page deliberately shows students across every central_email (no
  admin role exists; a handful of trusted coworkers share full visibility).
  Messages/threads, by contrast, ARE scoped per-operator central_email -
  worker A doesn't see worker B's live inbox.
- `students.deleted_at` is a **soft delete**. Deleted students (and all their
  messages/threads) are hidden everywhere in the console until restored, but
  nothing is ever purged from Postgres. Rules: max 5 deleted at once (with a
  confirmation step warning about pending-message counts, override allowed);
  any operator can delete any student regardless of owner (no audit trail by
  design, deliberately declined); replying as a deleted student is blocked
  server-side (`StudentDeletedError` in `reply.ts`); incoming mail for a
  deleted student's address still gets recorded (data isn't lost) but stays
  invisible until restored; re-pasting a deleted student's email through the
  import box auto-restores them.
- `students.first_name`/`last_name` - split from the free-text `name` field
  on the first space; any middle name lands in `last_name` (no separate
  middle-name column, decided deliberately - nothing needs to filter on it
  alone).
- `students.college`/`year_enrolled` - optional, added for the admin roster;
  captured via an optional 4th/5th column in this app's own paste-import
  format (`name,email,password,college,year_enrolled`) - **not** Migadu's
  CSV format, which is a separate, unrelated provisioning step.
- `messages.handled_without_reply` - true when an operator used "Mark as
  handled" instead of replying. That button only appears when the message
  actually contains a real `http(s)://` link (see Known bugs fixed, below) -
  it exists for cases like "please verify via this link", not as a way to
  dismiss a message that genuinely needs a written reply.
- Reply-send is race-safe: `sendReply()` in `reply.ts` atomically claims a
  message (`UPDATE messages SET replied=TRUE WHERE id=$1 AND replied=FALSE`)
  *before* doing any SMTP I/O, and rolls the claim back to `replied=FALSE` if
  SMTP (or anything else) fails. Never do slow I/O inside that claim window.

## Backend file map (`backend/src/`)

- `server.ts` - Express app, all routes, session cookie auth gate, SSE setup
- `auth.ts` - login = live IMAP auth check against the central mailbox itself
- `db.ts` - pg Pool from env vars (don't rewrite, already works)
- `students.ts` - **per-operator** student fetch/CSV-paste-import (used by
  the "Add students" tab and the empty-roster first-run prompt)
- `studentsAdmin.ts` - **cross-operator** admin roster: search (pg_trgm),
  keyset/cursor pagination, soft delete, restore, pending-message counts
- `centralMailboxes.ts` - registry of which mailboxes have logged in
- `mailboxSync.ts` - per-mailbox IMAP IDLE watcher + periodic fallback sync
- `sync.ts` - the actual IMAP fetch/parse/insert-into-`messages` logic
- `thread.ts` - groups messages into threads (union-find on
  message_id/in_reply_to/reference_ids), thread summaries, full thread fetch;
  thread list is always sorted newest-first, but within a thread the oldest
  unreplied message is always what gets offered up for reply (never skip
  ahead to a newer one)
- `reply.ts` - SMTP send as the student, BCC central, threading headers,
  attachments, the claim-before-send logic
- `realtime.ts` - SSE broadcast per central mailbox
- `sync-mail.ts`, `test-reply.ts` - early one-off CLI scripts, superseded by
  the above, kept around but not part of the live app

## Frontend file map (`frontend/src/`)

- `App.tsx` / `Console.tsx` - shell, tabs (Pending/All/Replied), SSE-driven
  auto-refresh
- `Login.tsx` - central mailbox login form
- `MessageList.tsx` / `ThreadView.tsx` - thread list and the reply panel
- `ManageStudents.tsx` - Students / Deleted / Add-students tabs (search,
  infinite scroll, delete-with-confirm, restore, CSV-style paste import)
- `linkify.ts` - sanitizes HTML mail bodies; only real `http(s)://` links
  count as "this message has a link" (mailto: quoted addresses from Gmail's
  own auto-linking do NOT count and are de-linked to plain text - this was a
  real bug, see below)
- `api.ts` / `types.ts` - fetch wrappers and shared types

## Known bugs fixed this session (context for why the code looks like this)

1. **Layout capped narrow on wide screens** - leftover Vite template CSS
   (`#root { width: 1126px; border-inline: ... }` in `index.css`) plus a
   1100px cap on `.app`. Fixed by removing the template leftover and raising
   `.app`'s max-width to 2000px (deliberately capped, not fluid - unlimited
   width would make email/reply text uncomfortably long-lined on very wide
   monitors; 2000px fills laptops/typical desktops with zero waste while
   capping line length on ultra-wide displays).
2. **Mailto quoted addresses treated as real links** - Gmail auto-linkifies
   quoted email addresses (`On ... <student@domain> wrote:`) as `mailto:`
   anchors in the HTML it sends. `containsLink()` was treating any `<a>` tag
   as a real link, wrongly forcing the "open link before marking handled"
   warning on ordinary replies with no actual link. Fixed to only count
   `http(s)://` anchors, and mailto: anchors are now unwrapped to plain text
   during sanitization so they don't even look clickable.
3. **"Mark as handled" offered on messages with no link** - could let an
   operator dismiss a message that genuinely needs a written reply (e.g.
   "send passport and aadhaar") without ever replying. Fixed: the button
   only renders at all when the pending message actually contains a real
   link.
4. **Thread list sort order inconsistent** - Pending/Replied sorted
   oldest-first while All sorted newest-first. Now all three sort
   newest-first; this only affects list order, not which message within a
   thread gets offered for reply (still always oldest-unreplied-first).
5. **Long emails (college/government letters) overwhelmed the thread view** -
   these are typically long, formal, multi-paragraph letters, not short chat
   messages. Fixed two ways: bubbles widened from 85% to 95% of the detail
   pane (shorter line-wraps for flowing text = less total height for the
   common case), and any message body taller than ~420px is clamped with a
   fade-out + a "Show full message"/"Show less" toggle (`ThreadView.tsx`,
   measured per-message via `scrollHeight` so short replies never show an
   unnecessary toggle).

## Standing working rules for this project

- **Confirm before every edit.** State the plan in plain terms and get
  explicit approval before touching any file - every time, even mid-task,
  even after an earlier general "go ahead". This was set as an explicit
  standing instruction after an unapproved edit was started once; don't
  assume it's lifted.
- Work incrementally, minimal diffs, don't rewrite working code without a
  specific reason.
- Run `npx tsc --noEmit` (backend) / `npx tsc -b --noEmit` (frontend) after
  any change before considering it done.
- Never print or echo secrets (`.env` values, API keys) into chat/output,
  even when the user pastes one directly - write it straight to the
  gitignored `.env` instead.
- Dev servers (`npx tsx src/server.ts` in `backend/`, `npm run dev` /
  `vite --port 5173` in `frontend/`) do **not** hot-reload backend changes -
  restart the backend process after backend edits (frontend/Vite does
  hot-reload). When restarting from an agent/tool context in this
  environment, plain `&` + `disown` can get killed by the tool's own timeout
  handling; use `(cmd &)` in a subshell instead, or `setsid`.
- This repo's git remote (`origin` -> GitHub) has no credentials configured
  in this sandboxed dev environment - `git push` will fail here
  (`gh` isn't even installed). Commits can be made locally; pushing needs to
  happen from a terminal with real GitHub auth (e.g. the user's own VS Code
  terminal).

## Setup (fresh machine)

1. PostgreSQL: create DB + app user, then `psql -f backend/schema.sql`
   (**unverified as of writing - test this on an empty DB before trusting
   it**).
2. `backend/.env` - copy `backend/.env.example`, fill in DB creds, IMAP
   host/port, SMTP host/port, `FRONTEND_ORIGIN`. Central mailbox credentials
   are supplied via login, not env vars (except `CENTRAL_EMAIL`/
   `CENTRAL_EMAIL_PASSWORD` which are only used by the old standalone CLI
   scripts). Never commit real values.
3. `cd backend && npm install && npx tsx src/server.ts`
4. `cd frontend && npm install && npm run dev`
5. Log in with a real central mailbox's IMAP credentials (this creates its
   `central_mailboxes` row and starts its IMAP watcher automatically).

## Not yet built / open items

- Migadu API mailbox provisioning: blocked on Migadu account verification
  (see above); nothing wired into the import flow yet even once unblocked.
- `backend/schema.sql` needs a real from-scratch verification run.
- Inline per-student editing (name/college/password) on the roster page -
  deliberately deferred; re-pasting through the import box is the only
  update path today.
- Production hardening not done (all known, all deliberate demo-only
  shortcuts): plaintext `smtp_password` in Postgres, DB localhost trust auth,
  no operator-level authentication beyond "can this IMAP login succeed",
  attachment size/type validation, rate limiting.
