# Student Mail Console

Handoff/reference doc for anyone (human or AI assistant) picking this project
up cold, mid-stream. If you're an AI continuing this work, read this whole
file before touching anything - it captures decisions and constraints that
aren't visible from the code alone.

## Agreed TODO plan (2026-09-21)

This section records the user's reviewed target plan, not implemented behavior.
It supersedes older roadmap assumptions where they conflict. The existing
implementation and historical notes below remain useful context. Steps 0–5
have been authorized and completed. Stop for confirmation before Step 6 or any
later step. Do not treat approval of this plan as blanket implementation or
deployment authorization. Discuss exact edits before making them.

- [x] **Step 0 — Record the plan here.** Include native spellchecking and
  defer AWS discussion until Steps 0–13 are complete. Native spellchecking is
  grouped with Step 13 so AWS is Step 14 as requested.
- [x] **Step 1 — Script verification of existing mailboxes and forwarding.**
  Verify central and all 15 student IMAP logins, verify central SMTP login,
  send one labeled test email to each student, and check all 15 forwarded
  copies in the central inbox. Report failures and observed delivery times.
  Completed 2026-09-21: all 16 IMAP logins and central SMTP authentication
  passed; all 15 sends were accepted and all forwarded copies were matched
  by Message-ID in the central INBOX. Observed 9–44 seconds after each send
  began; checks ran after all sends, so these are upper bounds, not exact
  delivery latency. This did not test app/UI latency. Test subject prefix:
  `ISM forwarding verification 2026-09-21T12:40:17.148Z`.
  Credentials were supplied privately; never place their values in this
  document, tracked test data, or logs.
- [x] **Step 2 — Colleges, domain, and central mailbox.** Create manually
  entered college records named exactly `KSMA CENTRAL`, `IHSM CENTRAL`, and
  `IHSM ELITE`. Use `myemailinfo.com` for the new setup. All three colleges'
  student mailboxes forward to `central.ksma@myemailinfo.com`. Do not use
  `system-design.in` as the new test domain. The older domain/mailboxes
  documented below describe the existing setup, not this target setup.
  Completed: `backend/migrations/001_colleges.sql` creates/seeds colleges;
  `backend/schema.sql` includes the same table/seed for fresh installations.
  Migration applied and rerun successfully with no duplicate colleges and
  unchanged existing student/message/reply counts. Local `.env` and tracked
  `.env.example` use Migadu IMAP with `ACTIVE_CENTRAL_EMAIL` set to the new
  central mailbox. Login and startup/fallback sync honor that optional
  setting; the old central registry row and its data are retained but it
  cannot log in or sync under the current configuration. New credentials
  were registered through normal login, not committed to source. Backend
  restarted; new login/session/pending-thread requests returned HTTP 200,
  old login returned 401, and only the new mailbox is selected for sync.
  Both TypeScript checks passed. No new test students have been inserted yet.
- [x] **Step 3 — Test student records.** Register the 15 already-created
  mailboxes listed below in the ordinary students table with `is_test = true`.
  Add `is_test` as a boolean defaulting to false for real students; do not
  create a separate test-emails table. Test records must exercise the normal
  inbox, reply, import, search, and college-scoping workflow.
  Completed 2026-09-21 with Step 4: all 15 approved roster rows were inserted
  and checked against the names, college IDs, Application Numbers, central
  mailbox, test flags, and privately supplied credentials. Five test
  students belong to each college. The eight pre-existing student records
  were compared before/after insertion and preserved unchanged. No separate
  test table or tracked password fixture was created. College-scoped UI and
  the new import/search behavior remain pending in their own steps.
- [x] **Step 4 — Student identity fields and constraints.** Store student
  name, globally unique email, `college_id`, Application No as text in
  `admission_id`, and `is_test`. Application No is unique within a college
  (college_id + admission_id), not globally. Duplicate names are allowed.
  Completed 2026-09-21: migration `002_student_identity.sql` adds nullable
  college_id (foreign key) and admission_id (text), plus non-null is_test
  default false and `students_college_admission_unique`. Existing unassigned
  students retain null college/admission IDs; no implicit reassignment.
  `schema.sql` contains the same fields/constraints for fresh deployment.
  Verified from scratch in a separate database on an isolated temporary
  PostgreSQL 16 instance: schema creation, college seed rows, leading zeros,
  default test flag, allowed duplicate names, application reuse across
  colleges, rejection of same-college duplicates/global duplicate emails,
  foreign-key enforcement, and compatibility with unassigned legacy rows.
  These independent scratch checks did not connect to the app database;
  an earlier check used a temporary schema in a rolled-back app-database
  transaction before the user requested full database isolation. Scratch
  instance stopped afterward. The approved migration and roster insertion
  intentionally changed the app database. Both TypeScript checks passed.
- [x] **Step 5 — Login first, then college picker.** Show the central
  mailbox login form first; after a successful login, show the three college
  buttons before entering the console. Operators using the shared central
  credentials may select any college; no separate operator-to-college
  permission assignments were requested.
  Completed 2026-09-21: public `GET /api/colleges` returns database college
  IDs/names. `POST /api/auth/login` now only verifies central mailbox IMAP
  credentials and creates a session with no college attached
  (`college: null`); it no longer requires or accepts a collegeId. A new
  authenticated `POST /api/auth/college` validates a collegeId and attaches
  that database college to the existing session (`setSessionCollege` in
  `auth.ts`); `Session.college` is now nullable both server- and
  client-side. `App.tsx` renders `Login` first, then `CollegePicker` when
  `session.college` is null, then `Console` once a college is selected.
  `CollegePicker.tsx` calls the new endpoint and hands the resulting session
  up, with its own loading/error state for the selection call.
  `GET /api/auth/me` and the login response both return `college` as
  possibly null. Reordered 2026-09-21 from the original college-first
  sequence at the user's request; originally completed the same day as
  college-picker-before-login (see history in git log for that version).
  Backend restarted. Both TypeScript checks passed. Live API checks passed:
  login succeeds without a collegeId and returns `college: null`;
  `/api/auth/college` returns 401 when called without a session (confirming
  it requires login first); `/api/colleges` unchanged. Full live login with
  real central mailbox credentials was not re-verified in this session (the
  password isn't in `.env`, which only holds old CLI-script credentials per
  the setup notes below); visual browser review of the new login-first ->
  college-picker -> console sequence remains with the user. This step does
  not filter mail/students by college: backend enforcement is Step 6.
- [x] **Step 6 — Enforce selected-college scoping.** Pending and Replied
  show only that college's threads. Scope student lists, searches, imports,
  deleted records, restoration, thread access, and reply actions on the
  backend as well as in the UI. Student college_id determines placement,
  even though the central mailbox is shared.
  Completed 2026-09-21: `requireAuth` in `server.ts` now requires a selected
  college on the session (400 "Select a college" otherwise) and passes
  `res.locals.collegeId` to every handler. `students.ts` (`fetchStudents`,
  `importStudents`), `studentsAdmin.ts` (`searchAdminStudents`,
  `softDeleteStudents`, `restoreStudent`, `pendingCountsForStudents`),
  `thread.ts` (`fetchAllMessages`/`fetchThread`/`fetchThreadSummaries`), and
  `reply.ts` (`fetchMessageById`/`fetchMessages`/`markHandled`) all now
  filter by `students.college_id` (messages via an `EXISTS` join through
  `student_email`), so Pending/Replied, the roster, search, delete/restore,
  and reply/mark-handled are all isolated per college. `importStudents` also
  rejects a pasted row whose email is already assigned to a different
  college, mirroring the existing central-mailbox conflict check.
  Rolled the user's follow-up request into this same step: the admin roster
  (Manage Students) is no longer cross-operator - `searchAdminStudents`,
  `softDeleteStudents`, and `restoreStudent` now also filter by
  `central_email`, matching how the "Add students" tab already scoped
  itself. This intentionally overrides the earlier documented decision that
  the roster deliberately showed every central mailbox's students (see the
  updated note in "Key schema decisions worth knowing" below). Since the
  Owner column would now always show the same value for every visible row,
  it was removed from `ManageStudents.tsx`/`AdminStudentRow`/the search
  placeholder text, along with the now-unused `.admin-owner` CSS rule.
  SSE broadcast (`realtime.ts`) was deliberately left unscoped by college -
  it still only keys off central mailbox, so an operator may get an extra
  "new mail" refresh ping for another college's message, but the refetch
  that follows goes through the newly college-scoped endpoints, so no data
  crosses colleges; this avoids threading college context through
  `mailboxSync.ts`/`sync.ts` for a purely-cosmetic extra refresh.
  Legacy pre-Step-4 students (8 rows, `college_id IS NULL`, owned by the old
  `pankaj@system-design.in` mailbox) are now invisible under every college
  until manually assigned - no bulk reassignment tool exists yet. In
  practice this changes nothing reachable today: `ACTIVE_CENTRAL_EMAIL`
  already prevents that old mailbox from logging in (see Step 2), so those
  records were already unreachable through the console before this step.
  Verified: both TypeScript checks passed (one legacy CLI script,
  `test-reply.ts`, needed a `CENTRAL_COLLEGE_ID` env var added to keep
  compiling against the new signatures - it is not part of the live app).
  Backend restarted. Could not drive a real IMAP login here (no working
  central mailbox password in `.env`), so verified scoping directly against
  the real dev database with the same filters the code now uses: the 15 test
  students split cleanly 5/5/5 across the three colleges with zero overlap
  under `central.ksma@myemailinfo.com`, and the 15 forwarding-verification
  messages joined to students split the same 5/5/5 with zero overlap.
  Confirmed unauthenticated requests to `/api/students` and `/api/threads`
  still return 401. The "no college selected" 400 gate is a direct read of
  a one-line check and was not independently curl-tested end-to-end (would
  need a real login). Visual browser review with two colleges side by side
  remains with the user, including confirming Manage Students only shows
  the current mailbox+college's roster and no Owner column.
  Follow-up cleanup 2026-09-21 (user-requested, done directly against the
  database, no code change): the 8 legacy `college_id IS NULL`
  `pilot.system-design.in` students (owned by `pankaj@system-design.in`)
  were soft-deleted (`deleted_at = NOW()`, reversible via the existing
  Deleted-tab restore flow, their 15 messages/10 replies untouched in
  Postgres); the stale `central_mailboxes` row for
  `pankaj@system-design.in` was permanently deleted (not reversible, but
  it only holds login credentials for a mailbox that was already unable to
  log in under the current `ACTIVE_CENTRAL_EMAIL`). The dev database now
  has exactly the 15 active test students (5 per college) and one
  registered central mailbox, `central.ksma@myemailinfo.com` - confirmed
  by direct query after the change.
  **Bug found and fixed 2026-09-21 in browser testing:** clicking a college
  on the picker had no effect and showed "Select a college". Root cause:
  this step's own `requireAuth` change (demanding a college already be on
  the session) was also guarding `POST /api/auth/college` - the endpoint
  that attaches a college to a college-less session for the first time -
  creating a deadlock (couldn't select a college because selecting one
  required already having one). Fixed by splitting the middleware into
  `requireAuth` (session only) and a new `requireCollege` (session with a
  college, sets `res.locals.collegeId`), chaining both on every
  college-scoped data route but only `requireAuth` on `/api/auth/college`.
  TypeScript check passed, backend restarted, confirmed
  `/api/auth/college` still 401s with no session at all. User confirmed
  fixed live in the browser (college selection and Manage Students/Add
  students both working).
  Follow-up 2026-09-21 (user-requested, found via browser screenshot):
  Manage Students' Students/Deleted tables were missing Application No
  entirely (a real gap - it's the field operators actually need to look
  students up by) while showing a College column that's always the same
  value now that the roster is college-scoped. Swapped them:
  `searchAdminStudents` now selects `admission_id` instead of `college`,
  `AdminStudentRow` (both backend and frontend) updated to match, and the
  table column (backend/CSS class renamed `admin-college` ->
  `admin-admission`) now shows Application No instead of College.
  Verified by re-running the exact `searchAdminStudents` SQL directly
  against the dev database - `admission_id` values return correctly
  (confirmed against the real KSMA CENTRAL roster, including the two
  `Sample Student A/B` rows the user had already imported live). Both
  TypeScript checks passed, backend restarted.
- [x] **Step 7/8 — Header-based bulk student CSV import with password
  column.** Merged at implementation time: `students.smtp_password` is
  `NOT NULL`, so Step 7's format alone (no password) couldn't actually
  insert a row - Step 8's password column was required from the start.
  Require exact full college names, with no `KSMA` or `IHSM` aliases.
  Accept only rows belonging to the selected college and explain rejected
  rows. Existing email with identical supplied details: skip as already
  imported. Existing email with conflicting details: flag for review,
  never silently overwrite. New email with an Application No already used
  in that college: flag for review. Otherwise import, even if a name
  matches. Check conflicts both within a batch and against previous
  batches. Report imported/skipped/rejected rows and reasons. Set is_test
  separately from CSV; the supplied 15 are tests. Final CSV format is
  `Student Name,College,Application No,Email,Password`. Each row supplies
  its student mailbox password for SMTP replies.
  Completed 2026-09-21: rewrote `importStudents` in `students.ts` to
  replace the old ad hoc `name,email,password,college,year_enrolled`
  paste format entirely (that format, and CSV-settable `year_enrolled`,
  are gone from this import path; the columns/values stay in the schema
  and existing rows). New `InvalidHeaderError` rejects the whole batch up
  front if the first line isn't exactly
  `Student Name,College,Application No,Email,Password` (case-insensitive).
  College text must exactly match one of the `colleges` table's full names
  (via `listColleges()`, not hardcoded) and must match the operator's
  currently selected college from the session - a row for another college
  is rejected with a message naming both colleges, never redirected or
  imported anyway. Duplicate email or Application No is checked both
  within the pasted batch (rejects the later occurrence, naming the
  earlier line) and against the database. An existing email with every
  field identical is a no-op (`skipped`), except a soft-deleted match is
  restored (counted as `imported`) - preserving the existing repaste-to-
  restore feature - while any differing field is rejected for manual
  review and never overwritten. A new email whose Application No is
  already used by a different email in that college is rejected. `is_test`
  is hardcoded `FALSE` on every CSV-inserted row - never settable via this
  import path. `ImportResult` changed from `{imported, updated, rejected}`
  to `{imported, skipped, rejected}`; `RejectedRow` dropped its `owner`
  field (the reason string is now self-descriptive). Frontend
  (`ManageStudents.tsx`'s Add-students tab, `Console.tsx` passing
  `college.name` down) updated to match: new hint text, header-inclusive
  placeholder using the operator's real selected college name, and
  imported/skipped/rejected counts in the result summary.
  Verified: both TypeScript checks passed. Ran 10 scenarios directly
  against the real dev database (bad header; a clean 2-row import; an
  identical re-paste; a conflicting-details re-paste; a wrong-college row;
  an abbreviated college name; a duplicate email within a batch; a
  duplicate Application No within a batch; a new email colliding with an
  existing Application No; a soft-deleted identical row restoring) - all
  10 passed, and all test rows (`zzztest*@myemailinfo.com`) were deleted
  afterward, confirmed by a follow-up count query that the real 15
  active/8 soft-deleted student rows were unaffected. Backend restarted.
  Could not exercise the actual `POST /api/students/import` HTTP route or
  the browser UI (no real login here); visual browser review of the new
  Add-students flow, including a real header-based paste, remains with
  the user.
  Follow-up simplification 2026-09-21 (user-requested): dropped the College
  column entirely - the server already knows the operator's selected
  college from the session, so the header/format is now
  `Student Name,Application No,Email,Password` and every imported row
  belongs to the currently selected college directly (no per-row
  cross-check against a mismatched college; that was judged not worth the
  extra column for this workflow). Also made Password optional per row: a
  blank password defaults to the literal string `password` (deliberately
  weak, at the user's explicit request - real rosters should still supply
  a real one). Re-verified with 4 scenarios directly against the dev
  database (old College-containing header now correctly rejected; a blank
  password defaults and is stored as literally `password`; re-pasting with
  that default explicit is a no-op skip; the `college`/`college_id`
  columns are still populated correctly from the session, not the CSV) -
  all passed, test rows cleaned up, both TypeScript checks passed, backend
  restarted.
  Follow-up 2026-09-21 (user-requested): made the header line optional
  instead of required, since parsing is purely positional and never used
  the header to map columns - it only ever served as an up-front sanity
  check. If the first non-empty line matches
  `Student Name,Application No,Email,Password` exactly (case-insensitive)
  it's skipped; otherwise every line is treated as data. Removed the now-
  unused `InvalidHeaderError` class and its handling in `server.ts`.
  Re-verified with 3 scenarios against the dev database (with header,
  without header, header matched case-insensitively) - all imported
  correctly, test rows cleaned up, both TypeScript checks passed, backend
  restarted.
- [x] **Step 9 — Search by Application No.** Provide type-to-search partial
  matching across student name, email, and Application No, scoped to the
  selected college. Display Application No in the roster. "Elastic type"
  describes the search experience; use existing PostgreSQL capabilities,
  not a new Elasticsearch service.
  Completed 2026-09-21: displaying Application No in the roster was
  already done as part of a Step 6 follow-up. The actual gap was that
  `searchAdminStudents`'s ILIKE search concatenation never included
  `admission_id` at all, so searching an Application No returned nothing
  even though the column was now visible. Added
  `coalesce(admission_id,'')` to that concatenation in `studentsAdmin.ts`.
  Added migration `003_search_admission_id.sql` to rebuild
  `idx_students_search_trgm` with the matching expression (a GIN trgm
  expression index is only usable when the WHERE clause expression matches
  it exactly) and updated `schema.sql` to match for fresh installs.
  Updated the search box placeholder to mention Application No. The
  existing 300ms-debounced type-to-search UI already provided the
  "elastic type" partial-match experience described - no UI logic change
  needed there, only extending what the underlying query searches.
  Applied migration `003` to the app database (the same live-database
  change pattern already used for migrations `001`/`002`). Verified
  directly against the dev database: searching the partial string `9729`
  matches `Test Student 1 KSMA` (admission_id `97299038`); confirmed via
  `EXPLAIN` with `enable_seqscan` forced off that the rebuilt index is a
  valid, usable match for the search expression (a `Bitmap Index Scan` on
  `idx_students_search_trgm`) - it isn't chosen at today's 23-row scale
  (correct planner behavior, not a bug) but will be used automatically
  once the table is larger. Both TypeScript checks passed, backend
  restarted.
- [ ] **Step 10 — Diagnose and fix central-inbox-to-UI latency.** The user
  observed 3–4 minutes after central inbox arrival; whether insertion or UI
  notification is delayed remains unmeasured. Time detection, fetch,
  database insertion, broadcast, and browser receipt. Verify actual IDLE
  operation and polling configuration; an earlier IDLE lock fix is already
  documented below and must not be mistaken for a new unimplemented fix.
  Replace repeated latest-50 full-message fetches with incremental IMAP UID
  tracking per mailbox, including UIDVALIDITY recovery. Use a persistent
  connection and IDLE notifications, queue a follow-up pass for arrivals
  during sync, notify the UI promptly after saving messages, and retain
  fallback polling/reconnect catch-up. Handle all messages in college bulk
  sends, including bursts exceeding 50 and downtime backlogs. Inspect
  multi-student recipient handling and global Message-ID deduplication so
  one bulk message does not hide other students' copies or mix their
  conversations across colleges. Verify the fix with measured test results.
- [ ] **Step 11 — Branding.** User will provide high-resolution ISM Edutech
  and college logos. Landing: ISM Edutech branding plus college buttons.
  Selected-college login and inner/mail pages: ISM Edutech and selected
  college logos, with the selected college's full name.
- [ ] **Step 12 — Professional inbox UI.** Preserve consistent full width.
  Use a compact branded header with college and logged-in mailbox, a fixed
  desktop thread-list width and flexible reading pane, clear student
  name/email, subject, preview, timestamp, and selection state. Improve
  message readability and attachment/composer layout; show the student's
  sending address. Retain Pending / Replied labels per the latest approved
  wording, rather than the earlier proposed Handled rename.
- [ ] **Step 13 — Rich-text composition and native spellchecking.** Add
  Bold and Italic toolbar controls and Ctrl/Cmd+B and Ctrl/Cmd+I shortcuts.
  Preserve formatting in sent mail and conversation history; store/send
  sanitized HTML with a plain-text fallback while retaining attachments
  and threading. Enable browser-native spellcheck in the composer, with
  browser-provided suggestions and manual corrections. Availability varies
  by browser/language. No automatic rewriting or integrated grammar service
  in this scope; grammar-service integration is deferred.
- [ ] **Step 14 — Discuss AWS migration after Steps 0–13.** Moving the app
  to AWS is a future discussion, not current deployment authorization.
  Agree on architecture, costs, security/credentials, data migration,
  backups, and rollout before provisioning or deploying anything.

### Approved test roster (passwords intentionally omitted)

Final import needs the Password column from Step 8, supplied privately.
These Application Numbers replace the earlier shared `TEST` values.

| Student Name | College | Application No | Email |
|---|---|---|---|
| Test Student 1 KSMA | KSMA CENTRAL | 97299038 | test.ksma1@myemailinfo.com |
| Test Student 2 KSMA | KSMA CENTRAL | 88067600 | test.ksma2@myemailinfo.com |
| Test Student 3 KSMA | KSMA CENTRAL | 58323203 | test.ksma3@myemailinfo.com |
| Test Student 4 KSMA | KSMA CENTRAL | 10610719 | test.ksma4@myemailinfo.com |
| Test Student 5 KSMA | KSMA CENTRAL | 60253661 | test.ksma5@myemailinfo.com |
| Test Student 1 IHSM | IHSM CENTRAL | 92134630 | test.ihsm1@myemailinfo.com |
| Test Student 2 IHSM | IHSM CENTRAL | 22264851 | test.ihsm2@myemailinfo.com |
| Test Student 3 IHSM | IHSM CENTRAL | 81945572 | test.ihsm3@myemailinfo.com |
| Test Student 4 IHSM | IHSM CENTRAL | 88758662 | test.ihsm4@myemailinfo.com |
| Test Student 5 IHSM | IHSM CENTRAL | 45543760 | test.ihsm5@myemailinfo.com |
| Test Student 1 IHSM ELITE | IHSM ELITE | 33348853 | test.ihsmelite1@myemailinfo.com |
| Test Student 2 IHSM ELITE | IHSM ELITE | 39342146 | test.ihsmelite2@myemailinfo.com |
| Test Student 3 IHSM ELITE | IHSM ELITE | 90846470 | test.ihsmelite3@myemailinfo.com |
| Test Student 4 IHSM ELITE | IHSM ELITE | 91195136 | test.ihsmelite4@myemailinfo.com |
| Test Student 5 IHSM ELITE | IHSM ELITE | 13079785 | test.ihsmelite5@myemailinfo.com |

### Implementation decisions still requiring discussion

- Treatment of existing pilot-domain students/messages: no implicit deletion
  or college reassignment is authorized.
- Conflict-resolution edits, restoration behavior during the new import,
  and legacy import compatibility need an exact implementation plan.
- Validate schema migration, college isolation, imports, search, reply
  formatting, attachments, burst delivery, and UI updates when implemented.
  Run the required TypeScript checks and appropriate build/tests; restart
  the backend after approved backend changes.

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

Current operation after Step 2 uses `myemailinfo.com` and
`central.ksma@myemailinfo.com`, with IMAP `imap.migadu.com:993` and SMTP
`smtp.migadu.com:465`. `ACTIVE_CENTRAL_EMAIL` restricts login/background sync
to that mailbox. Its credentials are supplied through login. Existing
pilot-domain records are retained. The following older setup notes are
historical and are not the current runtime configuration.

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

See `backend/schema.sql` for the authoritative recreate-from-scratch schema.
Verified 2026-09-21 against an empty scratch database on an isolated
PostgreSQL 16 instance, including the Step 4 identity constraints. Tables:
`colleges`, `students`, `messages`, `replies`, `central_mailboxes`. Requires
`pg_trgm`. Incremental migrations are in `backend/migrations/`; apply in
numeric order to an existing database, not after loading the current fresh
schema. Scratch validation does not constitute an AWS deployment test.

Local demo setup: PostgreSQL 16 in WSL, DB `student_mail`, app user
`student_mail_app`, **localhost trust auth** configured in
`/etc/postgresql/16/main/pg_hba.conf` (`host student_mail student_mail_app
127.0.0.1/32 trust`) scoped to the `student_mail` database specifically -
trust auth does NOT apply to other databases on the same Postgres instance
(learned the hard way: `createdb` for a different DB name hangs forever
prompting for a password that never comes). This is demo-only; production
needs real DB auth/secrets.

### Key schema decisions worth knowing

- `students.central_email` records which operator/mailbox currently handles
  that student's mail. It was originally **not** treated as a tenant
  boundary for the admin roster (the roster deliberately showed students
  across every central_email, since no admin role exists). As of Step 6
  this was deliberately overridden at the user's request: the admin roster
  (Manage Students) is now scoped by `central_email` **and** `college_id`,
  same as everything else - one operator's console never shows another
  operator's or another college's students. Messages/threads were always
  scoped per-operator central_email and are now also scoped by college_id.
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
6. **"Mark as handled" was too easy to trigger** - "has a link" alone caught
   ordinary human senders who happened to share a link (e.g. a college
   letter with a reference URL). Tightened to require BOTH an automated
   sender address (`donotreply@`/`no-reply@`/`noreply@` patterns, see
   `isAutomatedSender()` in `linkify.ts`) AND a real link - the button is
   for messages that genuinely can't get a human reply, not any message that
   merely contains a URL.
7. **Thread pending status didn't match how a burst of messages actually
   gets handled** - originally a thread was "pending" if ANY individual
   message lacked its own `replied=true` row, meaning if a sender sent 10
   messages before you got to reply, replying to just one (even one that
   addressed everything) left the thread showing pending forever unless you
   wrote 10 separate replies. Redone as timing-based: a message only counts
   as still-pending if it arrived *after* the most recent reply/mark-handled
   action in its thread (`latestResolvedAt()`/`stillPending()` in
   `thread.ts`, mirrored in `ThreadView.tsx`'s reply-target selection). A
   new message that arrives after your reply correctly flips the thread back
   to pending - this only changes how thread-level status is *computed*, not
   the underlying `messages.replied` column, which still records whether
   that specific message got its own matching reply (kept for any future
   audit need). `studentsAdmin.ts`'s delete-confirmation pending-count
   (`pendingCountsForStudents`) was updated to use the same definition via a
   new `countEffectivelyPendingByEmail()` export, so it never disagrees with
   what the console shows.
8. **New mail took 30s to over a minute to appear - the IMAP IDLE watcher
   was silently never working.** Root cause, confirmed by reading the
   installed `imapflow` source directly: `mailboxSync.ts`'s watcher called
   `client.getMailboxLock("INBOX")` and held that lock for its entire
   lifetime. `imapflow`'s auto-IDLE only starts once the connection is not
   "busy" (`connectionBusy()` checks `this.currentLock`, which stays set for
   as long as a lock is held), so IDLE was never actually issued to the
   server, and `client.on("exists", ...)` never fired from a real push -
   every single "new mail" detection was actually coming from the 60s
   fallback poll (`FALLBACK_SYNC_INTERVAL_MS`) the whole time, which is
   exactly the 0-60s (average ~30s) delay that was observed. Fixed by using
   `client.mailboxOpen("INBOX")` instead of `getMailboxLock()` for the
   watcher (selects the mailbox without taking a lock, matching imapflow's
   own documented usage pattern for relying on auto-IDLE) - live-tested
   after the fix: a real test email was detected within ~14 seconds of
   arriving at the central mailbox, not the old up-to-60s delay. This also
   explains why the 50-message bulk re-fetch in `sync.ts` (see open items
   below) wasn't obviously a problem yet - it was only ever running on that
   same slow 60s cadence.
9. **Dropped the "All" tab/status** from both the UI (`Console.tsx`) and the
   backend (`/api/threads` and `fetchThreadSummaries` in `thread.ts`, now
   `"pending" | "replied"` only) - every thread is always exactly one of
   Pending or Replied (no third state), so "All" was purely the union of the
   other two with nothing unique in it, just extra UI surface for clerks.
   The older `/api/messages` per-message endpoint (not used by the current
   UI) still accepts `status=all` - left alone since it wasn't part of this
   change and isn't reachable from the console.

## Standing working rules for this project

- **Close out every completed step.** Update this file with the completed
  checkbox, changes, and verification results; commit that step's changes
  locally using a title prefixed with its step number (for example,
  `Step 5: Add college picker before login`), then push/sync to the remote.
  Report the commit ID and any sync failure. Ask for confirmation before
  beginning the next step. Documentation updates, check-in, and sync are
  part of the authorized step closeout. Do not mark unfinished steps complete.
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
   (fresh-schema creation verified in an isolated PostgreSQL 16 scratch DB
   on 2026-09-21; configure deployment-specific access/permissions separately).
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

- **`sync.ts`'s IMAP fetch is sequence-number-based, not UID-based - fix
  before scaling up.** It always fetches the last 50 messages by sequence
  number (`mailboxExists - 49` to `*`) every sync run, relying on `ON
  CONFLICT (message_id) DO NOTHING` for dedup. This is safe at demo scale
  (a handful of students) but has a real correctness ceiling, not just
  inefficiency: if more than 50 new messages land in a central mailbox
  between two sync runs (a backlog after downtime, or just natural volume
  approaching 1600 students), anything beyond that window is never fetched
  at all - silently missed, not delayed. It also re-downloads/re-parses full
  message source for up to 50 messages on every sync tick even when only one
  is new. Proper fix: track the last-processed IMAP UID per mailbox (e.g. a
  new column on `central_mailboxes`) and fetch only messages with UID
  greater than that each time, advancing the cursor after each successful
  sync. Now that the IDLE watcher fix (above) means sync actually runs
  promptly on real new mail rather than only every 60s, this matters more,
  not less - deliberately left alone tonight since it's a bigger change than
  the demo needed.
- Migadu API mailbox provisioning: blocked on Migadu account verification
  (see above); nothing wired into the import flow yet even once unblocked.
- Keep `backend/schema.sql` synchronized with every migration. Fresh-schema
  and student identity checks passed in a separate scratch DB in Step 4;
  repeat relevant validation when later schema changes are made.
- Inline per-student editing (name/college/password) on the roster page -
  deliberately deferred; re-pasting through the import box is the only
  update path today.
- Production hardening not done (all known, all deliberate demo-only
  shortcuts): plaintext `smtp_password` in Postgres, DB localhost trust auth,
  no operator-level authentication beyond "can this IMAP login succeed",
  attachment size/type validation, rate limiting.
- **Duplicate-name handling across import batches - needs more design
  thought, explicitly deferred to after the demo.** Today, two different
  students sharing a name is already fine as long as their emails differ
  (email is the unique identifier; the roster disambiguates by showing
  email/college/owner alongside the name). What's genuinely unresolved: at
  1600-student scale, imports happen across multiple CSV batches over time
  (not all at once), and there's currently no collision detection at all
  when a name reappears in a later batch. Two real risks this doesn't catch:
  (a) a clerk typos an email that happens to collide with an existing
  student's email - the import silently upserts (`ON CONFLICT (email) DO
  UPDATE`) and overwrites that existing student's name/password/college with
  the new batch's values, with no warning that the name attached to that
  email just changed; (b) the reverse - two genuinely different people with
  the same name in different batches are fine today, but there's no
  "did you mean this existing student?" check to catch a clerk accidentally
  re-entering the same real person twice under a second email. Needs a
  decision on whether import should warn (not necessarily block) when a
  pasted row's name closely matches an existing student under a
  *different* email, and/or warn when an existing email's name is about to
  change to something unrelated.
