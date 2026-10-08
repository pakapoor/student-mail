# Student Mail Console

Handoff/reference doc for anyone (human or AI assistant) picking this project
up cold, mid-stream. If you're an AI continuing this work, read this whole
file before touching anything - it captures decisions and constraints that
aren't visible from the code alone.

## Start here (current state — read this first)

Written 2026-10-01. Update this block whenever a step is deployed.

| Item | State |
|---|---|
| Production | EC2 at `app.myemailinfo.com` (52.86.63.127), one instance running Node, PostgreSQL 18 and nginx. Last deployed code: Step 47 (`4221301`; docs-only commits follow it). Check the real state with `git log -1` on the server. |
| Last deployed steps | 34 flexible name search, 35 Login screen when signed out in another tab, 36 reason line on rejected rows, 37 add students from name + Application No (Migadu mailbox created automatically), 38 simpler Add students hint, 39 separate Search/Add students dialogs with the clerk-friendly add, 40 repeated Application No flagged in the box, 41 students dialogs stay open when the mouse leaves the card plus a clearer Add students hint, 42 Add students hardening (no reload while adding, plain errors, audit log, adopt a lost-reply mailbox), 43 Migadu call times on the status page (migration 017), 44 used Application No flagged before adding, 45 Search students opens on the login college, 46 Search students with less clutter (one small All colleges button), 47 a search looks in every college and can be cleared with a ✕, 31a-d (UID reset fix, lowercase email indexes, cached rejection date, thread open reads one student), nginx tuning (HTTP/2, gzip, asset caching). |
| Held back, not on GitHub | Steps 32 (stored thread summaries, queue, worker) and 33 (full test suite, coverage, mutation and load tooling): `git stash` entry "Full Steps 31-33 working tree ..." and a copy at `~/holds/step-32-full-20260929T222943/` on the dev machine. The user plans to work on them at a weekend. |
| Open decisions | CloudFront or a nearer AWS region (round trip is ~0.28 s, the real latency); policy 015 on clearing cached registration dates when their last supporting Edugate mail is deleted. |
| Planned, not built | Search that tolerates mistyped names (`pg_trgm` similarity; see Step 34); instant sign-out of an idle background tab (cross-tab signal; see Step 35); Step 17b hot-list polling proposal. |
| Next step number | 48. |

### Step index

Newest sections are at the top of this file, the older ones below the "Agreed TODO plan".

| Step | What | State |
|---|---|---|
| 0-13 | Plan, colleges and central mailbox, test students, identity fields, login then college picker, college scoping, CSV import, Application No search, latency fix, branding, inbox UI, rich-text reply and spellcheck | done |
| 14 | AWS deployment (EC2, nginx, Certbot, PostgreSQL on the instance) | live since 2026-09-22; its checkbox in the plan below was never ticked |
| 15 | Search on the console | done |
| 16 | Automatic per-student mailbox check on search | built and live; checkbox left open pending the user's UI confirmation |
| 17 A | Rolling daily sweep of every student's mailbox | done |
| 18 | Edugate registration status (code, login, rejection), filter buttons | done |
| 19 | Fix: emails lost when Migadu returns them without content | done |
| 20 | Hot list: watch a student's mailbox while staff wait for registration | done |
| 21 | System status page (`/status`) | done |
| 22-24 | UI polish, Manage students filters, Application No in the list | done |
| 25-26 | Review fixes and backups, sync reliability | done |
| 27-29 | Code expiry alerts, recent problems kept across restarts, one code row per student | done |
| 30 | Students dialog: all colleges, read-only, status link, year on import | done |
| 31a-d | UID reset fix, lowercase email rule and indexes, cached rejection date, thread open in one snapshot | deployed 2026-09-29 |
| 32-33 | Stored thread summaries; full test suite, coverage, mutation and load tooling | held back (see above) |
| 34 | Flexible student search | deployed 2026-10-01 |
| 35 | Login screen when signed out in another tab | deployed 2026-10-01 |
| 36 | Reason line on rejected rows in the list | deployed 2026-10-08 |
| 37 | Add students from name + Application No, mailbox created automatically | deployed 2026-10-08 |
| 38 | Add students: simpler hint text | deployed 2026-10-08 |
| 39 | Search students and Add students as two buttons and two dialogs; clerk-friendly input, live results, one retry | deployed 2026-10-08 |
| 40 | Add students: a repeated Application No is flagged in the box | deployed 2026-10-08 |
| 41 | Students dialogs no longer close when the mouse leaves the card; clearer Add students hint | deployed 2026-10-08 |
| 42 | Add students: no reload while adding, plain error messages, audit log, adopt a lost-reply mailbox | deployed 2026-10-08 |
| 43 | Migadu call times: audit log and a graph on the status page (migration 017) | deployed 2026-10-08 |
| 44 | Add students: an Application No already used in the college is flagged before adding | deployed 2026-10-08 |
| 45 | Search students opens on the college chosen at login | deployed 2026-10-08 |
| 46 | Search students: less clutter, one small All colleges button | deployed 2026-10-08 |
| 47 | Search students: a search always looks in every college, with a clear (✕) button | deployed 2026-10-08 |

## Operating prod (runbook)

Read-only investigation is always fine; changing anything on the server needs the owner's approval.

- **Access:** `ssh ubuntu@52.86.63.127` works directly from the dev machine (the browser-based EC2
  Instance Connect described in `command.md` is the original, older route).
- **Services:** `student-mail.service` (the backend; `systemctl is-active student-mail`), nginx,
  PostgreSQL 18. Logs: `sudo journalctl -u student-mail --since "-10min" --no-pager` (add
  `-p warning` for problems). A stop shows "Failed with result 'exit-code'" with status 143 on every
  restart; that is the normal stop signal, not a failure.
- **Database, read-only:** there is no `DATABASE_URL`. On the server, load the app's env file and
  run psql with it, never printing the password: `cd ~/student-mail/backend && set -a && . ./.env &&
  set +a && PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
  -X -A -c "..."`. Wrap experiments in `BEGIN READ ONLY; ... ROLLBACK;`.
- **Deploy, backend change:** (1) fresh backup if the database changes (below); (2) apply any new
  migration as the app role with `ON_ERROR_STOP`; (3) `git pull --ff-only` in `~/student-mail`;
  (4) `sudo systemctl restart student-mail.service`; (5) verify: service active, "IMAP watcher
  connected", sync "no new messages", no warnings in the journal. Where a step's notes give a
  specific order (for example 31c needs the migration before the code), follow the notes.
- **Deploy, frontend-only change:** `git pull --ff-only`, then `cd frontend && npm run build`. No
  backend restart: nginx serves `frontend/dist` directly and logins and live-update streams stay up.
  Verify the page references the new `/assets/index-*.js` bundle.
- **Backups:** nightly `pg_dump` by cron at 20:30 UTC (`backend/scripts/backup-db.sh`) to
  `~/backups/nightly`, plus a gpg-encrypted copy in S3. Before a risky deploy take a manual dump
  into `~/backups`, plus an S3 copy through the script and a local copy on the dev machine
  (`~/backups`). Dumps contain plaintext mailbox passwords and never go into git.
- **nginx:** the site file `/etc/nginx/sites-available/student-mail` is NOT in the repository (HTTP/2,
  gzip, one-year immutable caching of `/assets/`). Dated backups sit beside it. Change it only with
  `sudo nginx -t` then `sudo systemctl reload nginx`.
- **Rollback:** `git revert` the commit, pull, restart (backend) or rebuild (frontend). Migrations
  so far are additive and harmless to older code.

## Deploy record — Steps 31a, 31b, 31c and nginx tuning (2026-09-29)

**Status: DEPLOYED 2026-09-29 22:39 UTC** at `c14d2de` (31c, which contains 31a and
31b), authorized by the user, with no consoles in use. Backend only; no frontend
rebuild. Order followed:

1. **Fresh backup in three places** (~22:32 UTC): server
   `~/backups/nightly/student_mail-20260929T223226Z.dump`; S3 (gpg-encrypted copy
   from `backup-db.sh`); local `~/backups/student_mail-20260929T223226Z.dump`.
2. **Read-only preflight on the live database** (PostgreSQL 18.6, 2,288 students,
   955 messages): mixed-case student emails 0, mixed-case message emails 0,
   registered students without a login email 0, students with a code date but no
   code email 0, `rejected_at` column absent.
3. `git pull --ff-only` on the server (`fe40491` -> `c14d2de`), then migration
   `014_lower_email_indexes.sql`, then `015_rejected_at.sql` as the app role with
   `ON_ERROR_STOP` (015 backfilled `rejected_at` for 34 students), then restart of
   `student-mail.service` (22:39:12 UTC).
4. **Verified afterwards:** service active, API listening, IMAP watcher reconnected,
   sync passes normal ("no new messages"), 0 errors in the journal after the restart;
   7 of 7 new indexes and both lowercase constraints present; 5 new triggers
   (`students_lowercase_email`, `messages_lowercase_student_email`,
   `messages_edugate_status_delete`, `messages_edugate_status_update`,
   `students_rejected_on_email_change`); 2,288 students / 955 messages unchanged;
   0 mixed-case emails. The Students dialog itself was not opened by the assistant
   (no browser); the user checks it.

Rollback for all three: `git revert` the commits and restart; the migrations are
additive and harmless to the old code (see the 31c deploy-order note before
re-deploying).

### Why the console felt slow: measurements (2026-09-29, after the deploy)

The perceived "second or so" is network latency, not the database or the list code.

| Measurement | Result |
|---|---|
| Whole console list call on a restored copy of the prod backup (PG18, 643 messages, 3.4 MB of bodies) | 26 ms median |
| Fetching all messages from the prod database, on the prod server | ~0.04 s including psql start-up; server load 0.00 |
| Roster query on prod: old shape / new shape / status counts | 3.1 ms / 0.5 ms / 0.3 ms |
| Round trip from the user's machine to prod | ~0.28 s |
| New connection (TCP + TLS) then first byte of a 1 KB page | ~0.6 s / 0.8-0.9 s |

**Correction of an earlier estimate:** earlier notes said the list took ~0.55 s and
Step 32 would cut it to a few milliseconds. The real backend time is ~40 ms, so
Step 32 would not make the console feel faster at this size. It stays held back.
The remaining floor is ~0.28 s per request (distance to the server); only a nearer
region or a CDN (CloudFront) would remove it - an open decision for the user.

### nginx tuning (server-side only; the nginx file is NOT in the repository)

Found: HTTP/1.1 only, gzip limited to HTML (the JS bundle, CSS and JSON were sent
uncompressed), and no long-term caching of the content-hashed assets. Changed in
`/etc/nginx/sites-available/student-mail` (Certbot-managed lines untouched):

```
    http2 on;
    gzip on;
    gzip_vary on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types application/json application/javascript text/css image/svg+xml text/plain;
    ...
    location /assets/ {                      # before "location /"
        root /home/ubuntu/student-mail/frontend/dist;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
```

Applied with `nginx -t` then `systemctl reload nginx` (no dropped connections).
Backup of the previous file: `/etc/nginx/sites-available/student-mail.bak-20260929T224822Z`;
rollback = copy it back, `sudo nginx -t`, `sudo systemctl reload nginx`.
Verified from the user's machine: `http_version=2`; JS bundle 313,669 -> 98,062 bytes
over the wire; CSS 36,658 -> 7,999 bytes; `index.html` not cached; API still answers
(401 unauthenticated). Requests after the first on one connection cost one round
trip (~0.28 s). The live-update (SSE) stream could not be tested without a session:
the user should confirm new mail still appears without a refresh.

### Still held back

Steps 32 (stored thread summaries, queue, worker) and 33 (full test suite, coverage,
mutation and load tooling) plus the remaining Step 31 pieces are not deployed and not
on GitHub. They are kept in `git stash` ("Full Steps 31-33 working tree ...") and in
a full copy at `~/holds/step-32-full-20260929T222943/` (outside the repository).
Next planned slice: 31d (opening a thread reads one student's data, with the
`replies` index). Open decisions: CloudFront or a nearer region; the 015 policy that
clears cached registration dates when their last supporting Edugate mail is deleted.

## Step 47 — Search students: a search always looks in every college

**Status: DEPLOYED 2026-10-08** at `4221301` (user authorized). Frontend only: `git pull --ff-only` and
`npm run build` in `frontend/` on prod (new bundle `index-atkC43CJ.js`); the backend service was NOT restarted
(still running since 08:44:22 UTC), so no logins or live-update streams were dropped. Verified: the page
serves the new bundle, `/api/threads` without a login answers 401, service and nginx active. The owner had
checked the UI locally first. Change (`ManageStudents.tsx`, `App.css`): A slip
from Step 45: once the dialog opened on the login college, typing a name or Application No in the search box
only searched that college, whereas searching has always covered every college (a student can belong to
another college, or the clerk may not know which). Now whatever is typed searches **all colleges**; the
college setting (the login college by default, or the small button) only narrows the list while the
box is **empty**. While something is typed the small button is hidden and the title says "all colleges"; when
the box is cleared the list returns to the chosen college. The status chips and counts follow the same rule
(all colleges while searching). The College column in the table shows which college each result belongs to.

- **Coming out of a search:** a small ✕ inside the search box (shown while there is text; "Clear search" for
  screen readers) clears the text and the list goes back to the chosen college. Escape is not used for this,
  because Escape closes the dialog.
- No backend, API or schema change; no new test (one derived value in the screen; the frontend has no
  component test setup). Frontend type check and build pass; backend suite unchanged (242 of 242).
- Deploy: `git pull --ff-only` and `npm run build` in `frontend/`; no backend restart. Rollback: `git revert`,
  rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Results from other colleges | Low | Intended: a search covers every college and the College column says which; the list without a search stays on the login college. |
| Data and backend | None | Frontend only; the same API call with the college filter left out while searching. |
| Rollback | Very low | `git revert`, rebuild the frontend. |

Overall risk: **very low**.

## Step 46 — Search students: less clutter (one small "All colleges" button)

**Status: DEPLOYED 2026-10-08** at `4c14c0c` (user authorized). Frontend only: `git pull --ff-only` and
`npm run build` in `frontend/` on prod (new bundle `index-DYL5kWQ-.js`); the backend service was NOT restarted
(still running since 08:44:22 UTC), so no logins or live-update streams were dropped. Verified: the page
serves the new bundle, `/api/threads` without a login answers 401, service and nginx active. The owner had
checked the UI locally first. Change: After Step 45 the dialog
opens on the login college, so the row of four college buttons (All, KSMA CENTRAL, IHSM CENTRAL, IHSM ELITE)
mostly took up room. It is gone. The title now names the college ("Search students · KSMA CENTRAL"), and a
**small button beside the search box** switches between that college and every college: "All colleges
2287" when looking at one college, "Only KSMA CENTRAL 1276" when looking at all (the title then says "all
colleges"). The Status buttons lost their visible "Status" label (kept for screen readers) and the dialog's
chips are slightly more compact, so the five fit on one line at the dialog's usual width and "Rejected" no
longer drops to a second line. `ManageStudents.tsx` (the `CollegeButtons` component and the colleges list
fetch are removed) and `App.css`.

- No backend, API or schema change; no new test (layout and one button; the frontend has no component test
  setup). Frontend type check and build pass; backend suite unchanged (242 of 242).
- Deploy: `git pull --ff-only` and `npm run build` in `frontend/`; no backend restart. Rollback: `git revert`,
  rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Finding a student of another college | Low | One more click than before (the All colleges button) instead of a button row; the button shows the all-college total. |
| Data and backend | None | Frontend only; the same API call with or without the college filter as before. |
| Narrow screens | Low | The search line wraps (button below the box) under 600 px. |
| Rollback | Very low | `git revert`, rebuild the frontend. |

Overall risk: **very low**.

## Step 45 — Search students opens on the college chosen at login

**Status: DEPLOYED 2026-10-08** at `a286efc` (user authorized). Frontend only: `git pull --ff-only` and
`npm run build` in `frontend/` on prod (new bundle `index-Cfuhy36i.js`); the backend service was NOT restarted
(still running since 08:44:22 UTC), so no logins or live-update streams were dropped. Verified: the page
serves the new bundle, `/api/threads` without a login answers 401, service and nginx active. The owner had
checked the UI locally first. Change: The College filter of the
Search students dialog used to start on **All** (every college); it now starts on the college the operator
chose at login (for example KSMA CENTRAL), so the list and the status counts are that college's. The **All**
button and the other colleges' buttons still work. `Console.tsx` passes `collegeId`, `ManageStudents.tsx`
uses it as the filter's starting value. The Add students dialog is not affected.

- No backend, API or schema change; no new test (a one-value initial state; the frontend has no component
  test setup). Frontend type check and build pass; backend suite unchanged (242 of 242).
- Deploy: `git pull --ff-only` and `npm run build` in `frontend/`; no backend restart. Rollback: `git revert`,
  rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Finding a student of another college | Low | The list opens on the logged-in college; the clerk presses All or another college to see the rest. The search box still searches within the chosen college filter. |
| Data and backend | None | Frontend only; the same API call with a college filter that the buttons already used. |
| Rollback | Very low | `git revert`, rebuild the frontend. |

Overall risk: **very low**.

## Step 44 — Add students: an Application No already used in the college is flagged before adding

**Status: DEPLOYED 2026-10-08 08:44 UTC** at `f5a8296` (see the Step 43 record for the order followed). Before this, a number already used by a
student of the college was only found after pressing Add (the row came back "Skipped, already used by
NAME"), and in a paste of ten some lines could be added and others skipped. Now the box asks the server
about the whole paste in **one request**, at two moments: when the clerk **leaves the box** (so a clash
shows up early) and when **Add is pressed** (the button shows "Checking numbers..." for a moment). A used
number is flagged in red like the other box errors, with the owner's name ("The Application No 30437 is
already used by ZUNAIRA SAQI. Check the number.", "(a deleted student)" when that student was deleted: their
number stays taken, as in the add flow), and nothing is created until it is fixed. Changing the number clears
the flag (flags are keyed by the number). A line with another mistake shows that mistake first.

- `backend/src/students.ts` `usedApplicationNumbers(collegeId, numbers)` and `POST /api/students/check-numbers`
  (`server.ts`, logged-in staff of the college; the body is a list of at most 50 whole numbers, otherwise
  400): one query on the existing unique (college, Application No) key; this college only; deleted students
  count; answers `{ used: { number: { name, deleted } } }`.
- `frontend/src/autoAddClient.ts` `postCheckNumbers` (via `api.ts`): advice only, so it **fails quietly**: any
  problem (server error, HTML page, dropped connection, 8 s without an answer, odd answer) means "nothing
  known" and adding goes ahead. `studentLines.ts`: `checkStudentLines(text, taken)` and
  `applicationNumbers(text)`; `ManageStudents.tsx`: the `taken` state, the blur and Add look-ups.
- The server still checks every number when adding (it can change between the look-up and Add: another clerk
  adding the same number in that second), so this is advice, never the last word.
- Tests: `backend/tests/usedNumbers.db.test.mjs` (4 tests against a throwaway PostgreSQL: owner names, this
  college only, deleted students, repeats and the cap), 6 new in `studentLines.test.mjs` (flag with the
  owner, deleted, not looked up / changed number, unknown owner, other mistakes first, `applicationNumbers`),
  3 new in `autoAddClient.test.mjs` (the call, no numbers = no request, every kind of failure = nothing
  known). Whole backend suite **242 of 242**; backend and frontend type checks and the frontend build pass.
  Tried against the local database with real numbers (known ones answered with the owner, an unknown one
  and another college's view answered nothing). The red display and the "Checking numbers" button have no
  automated test (no frontend component test setup).
- Deploy: `git pull --ff-only`, `npm run build` in `frontend/`, and a **backend restart** (new route); no
  migration. Rollback: `git revert`, restart, rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Wrongly blocking an add | Low | Only a number the database really holds for this college (including deleted students) is flagged; the clerk corrects the number. A look-up that fails never blocks. |
| Extra load | Very low | One small indexed query per blur or Add press, for the whole paste. |
| Showing a student's name | Very low | Same college and same login as Search students. |
| Stale answer | Low | A number taken a second after the look-up is still caught by the server when adding (shown as Skipped). |
| Data and database | None | Read-only; no schema change. |
| Rollback | Very low | `git revert`, restart, rebuild. |

Overall risk: **very low**.

## Step 43 — Migadu call times: audit log and a graph on the status page

**Status: DEPLOYED 2026-10-08 08:44 UTC** at `f5a8296` together with Steps 42, 43 and 44 (user authorized, in working hours
instead of the evening first agreed; about 2 consoles were open and reconnected at once). Order followed:
(1) fresh backup in three places (~08:43 UTC): server `~/backups/nightly/student_mail-20261008T084347Z.dump`,
the encrypted copy in S3 (via `backup-db.sh`), and local `~/backups/student_mail-20261008T084347Z.dump`;
(2) `git pull --ff-only`; (3) migration `017_migadu_calls.sql` as the app role with `ON_ERROR_STOP` (table
and index created; students 2,300 and messages 1,820 unchanged); (4) `npm run build` in `frontend/` (new
bundle `index-CU9N6rDH.js`); (5) restart of `student-mail.service`. Verified: service and nginx active, the page
serves the new bundle, `/api/threads`, `/api/status`, `/api/students/auto-add` and `/api/students/check-numbers`
all answer 401 without a login (so the new routes exist), the IMAP sync passes show "no new messages", the only
journal warning is the normal stop (status 143), `migadu_calls` starts empty. The assistant did not add a
student on prod, so no mailbox was created and the new status card shows "No calls yet" until staff add the
first student; that first real add is the live test. The owner wants to watch how long the
calls to Migadu take and, after a week or so, set the timeout from the real slowest calls (the 15 s and
the later 20 s were not derived from data). **Needs migration `017_migadu_calls.sql`** (additive: one new
table and index, safe to re-run, harmless to the old code) run as the app role **before** the new backend
is started, after a fresh backup (runbook).

- `backend/migrations/017_migadu_calls.sql` and `schema.sql`: table `migadu_calls` (`at`, `operation`
  lookup / create / remove, `ms`, `outcome` ok / refused / server-error / timeout / network). It holds no
  names, addresses or passwords. Rows older than 30 days are deleted (checked at most once an hour).
- `backend/src/migadu.ts`: every call is timed (to the answer's headers) and reported through an optional
  `onCall` hook; a 404 on a lookup or removal counts as ok. A recorder that throws never breaks a call.
- `backend/src/migaduTiming.ts` (new): `recordMigaduCall` writes an `[audit]` log line
  (`event: "migadu-call"`) and stores the row (fire and forget; a failure is logged and ignored);
  `migaduTimingStatus` is registered as a status provider (`migadu`): the last 7 days as one point per
  hour (calls, median, slowest, not-ok), the figures over the window (calls, median, 95th percentile,
  slowest, not ok, timeouts), the five slowest calls, and the timeout in force. `autoAdd.ts` passes the
  recorder when it makes the real client.
- Status page (`MigaduTimingChart.tsx`, `StatusPage.tsx`, `api.ts`, `App.css`): a "Migadu call times" card:
  a pill (No calls yet / All ok / N not ok / N timed out), a chart with one mark per hour (dot = median,
  bar up to the slowest call, red cap when a call in that hour did not end ok, dashed line at the timeout
  when it is within the chart's range, hover for details), the figures, and the slowest five calls.
- Tried for real on 2026-10-08 against Migadu and the local database: two `TEST CHART` students gave 4
  calls (lookup and create each, 0.2 to 0.7 s), median 0.49 s, none failed; the test mailboxes and local
  rows were removed afterwards (the 4 timing rows were left, so the local chart has data).
- Tests: `backend/tests/migaduTiming.db.test.mjs` (8 tests against a throwaway PostgreSQL: a call is
  stored and logged with only time, event, operation, ms and outcome; recording never throws; pruning;
  empty figures; median, 95th percentile, slowest, not-ok and timeouts; the 7-day window; hourly points;
  slowest five) and `backend/tests/migadu.test.mjs` is now 16 tests (adds timing and outcome of every kind
  of call, the 404 rule, a throwing recorder). `tests/helpers/testdb.mjs` now also clears `migadu_calls`.
  Whole backend suite **229 of 229**; backend and frontend type checks and the frontend build pass. The chart
  drawing itself has no automated test (no frontend component test setup); the owner checks the card.
- Deploy: backup, then `psql ... -f backend/migrations/017_migadu_calls.sql` as the app role with
  `ON_ERROR_STOP`, then `git pull --ff-only`, `npm run build` in `frontend/`, restart the backend. Rollback:
  `git revert`, restart, rebuild (the table can stay).

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Database | Low | One new table and index, additive; migration safe to re-run; old code ignores it. |
| Extra writes | Very low | One small insert per Migadu call (a few per added student), fire and forget. |
| Breaking an add | Very low | Timing and recording are wrapped so they cannot throw into the add flow (tested). |
| Privacy | Very low | The table and the log line hold only time, call kind, duration and outcome. |
| Status page | Low | A new card; if the table is missing or the query fails the card shows "Unavailable" and the rest of the page is unaffected. |
| Deploy order | Medium if forgotten | The migration must run before the new backend starts; otherwise the status card is "Unavailable" and each insert logs an error (adds still work). |
| Rollback | Very low | `git revert`, restart, rebuild. |

Overall risk: **low**.

## Step 42 — Add students: no reload while adding, plain error messages, audit log, adopt a lost-reply mailbox

**Status: DEPLOYED 2026-10-08 08:44 UTC** at `f5a8296` (see the Step 43 record for the order followed). Found by reading back through Steps
37-41 (owner chose items 1, 2, 6 and the audit log; the daily limit on new mailboxes was proposed and
declined; a limit on the number of digits of an Application No is a business rule for the owner, not
built; a Migadu alias clash for a name like "Postmaster" was judged too unlikely; the owner also asked
for the Migadu call timeout to go from 15 to 20 seconds).

- **No reload while a students dialog is open** (`frontend/src/Console.tsx`): the automatic reload onto a
  new build used to run whenever no email thread was open, so a deploy could wipe an open Add students
  dialog and stop an add halfway (lines already sent were saved). It now waits until the dialog is closed.
- **Plain messages for server problems** (`frontend/src/autoAddClient.ts`, new, used by `api.ts`): an nginx
  error page (HTML, not JSON) no longer shows "Unexpected token <"; a server that never answers ends after
  45 s instead of leaving a row on "Trying to add" for ever; a dropped connection, a 401 and an unreadable
  answer each get one plain sentence. The file has no browser-only imports so the backend tests can run it.
- **Plain messages for failed rows** (`backend/src/autoAdd.ts`, `migadu.ts`, `server.ts`): a failed line shows
  "The mailbox could not be created right now. Try again; if it keeps failing, tell the owner." (Migadu
  refused or failed; new `MailboxApiError`) or "Something went wrong adding this student..." (anything
  else); the route's own 500 is also a plain sentence. The technical detail still goes to the server log
  (`console.error`), never to the screen.
- **Adopt a mailbox made by an earlier try whose answer was lost** (`autoAdd.ts`, `migadu.ts`): if a create
  reaches Migadu but the answer never comes back (for instance the call times out), the retry used to find
  the address taken and make `x.y1`, leaving `x.y` as a stray mailbox. Now, when an address exists in Migadu
  but not in our `students` table, the console reads that mailbox (`inspect`: its name and when it was
  created) and **uses it instead of making another** if the name equals the student's (ignoring case) and it
  was created **10 minutes ago or less**. Anything else (another name, older, age unknown, or already in
  our table) is skipped for the next number as before. Migadu shows the creation time only as `"HH:MM"`
  for today (UTC, matching the time it was created) and as a date such as `"29/09/26"` for earlier days, so
  a mailbox made before today is never adopted. An adopted mailbox is audited as `mailbox-adopted`, is not
  removed if saving the student then fails, and the row says "A mailbox for this student had just been
  created by an earlier try, so it was used". Tried for real on 2026-10-08: a mailbox `test.adopt` was made
  through the API as a lost reply would leave it, the add then used it (no `test.adopt1`), and both the
  mailbox and the local row were removed afterwards. Remaining risk: two different students with the same
  name added within 10 minutes with no Application No clash (the Application No check normally stops that).
- **Migadu call timeout 20 s** (was 15 s): `REQUEST_TIMEOUT_MS` in `migadu.ts`. It was a round figure, not
  derived from measurements (calls take about 0.5-0.7 s; a whole line about 0.8 s). A line makes up to
  three or four Migadu calls, so in a very slow case it can exceed the browser's 45 s limit and nginx's 60 s;
  the adopt rule above is what makes that case safe to retry.
- **Audit log** (`autoAdd.ts`, `server.ts`): lines tagged `[audit]` in the server log, one JSON object each:
  `mailbox-created` the moment a Migadu mailbox exists (the part the console cannot undo), `mailbox-adopted`
  when an earlier try's mailbox is used, `mailbox-removed` when a failed save rolls a new one back, and one `student-add` per pasted line with its outcome (added, skipped,
  failed), name, Application No, email (only when added) and reason. Each carries the time, the central
  mailbox, the college and the client IP (staff share one login, so these identify who as far as possible).
  Never a password. Read them with `sudo journalctl -u student-mail | grep '\[audit\]'`. Limits: the journal
  is size-limited and shared with the noisy sync lines (on 2026-10-08 it reached back to 2026-09-21), so
  this is a trail, not permanent storage; a database table is the next step if a permanent history is
  wanted (needs a migration and a backup first).
- Tests: `backend/tests/autoAdd.test.mjs` is now 43 tests (friendly messages, no technical text on screen,
  audit entries for every outcome, the removed-mailbox audit, no password in any audit line, adopt and
  not-adopt cases);
  `backend/tests/migadu.test.mjs` is now 12 tests (adds inspect, creation time reading, the 20 s timeout);
  new `backend/tests/autoAddClient.test.mjs` (8 tests: good answer, server message passed on, HTML error
  page, other statuses, 401, dropped connection, timeout, wrong shape). Whole backend suite **217 of 217**;
  backend and frontend type checks and the frontend build pass. The reload-while-dialog-open rule is a
  one-line condition with no automated test (no frontend component test setup).
- Deploy: `git pull --ff-only`, `npm run build` in `frontend/`, and a **backend restart** (audit and message
  changes are backend code; no migration, no new setting). Rollback: `git revert`, restart, rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Data and database | None | No schema change; no new setting. |
| Audit log volume | Low | A few log lines per added student; the journal is already size-limited. Entries hold names, Application Nos and emails, no passwords. |
| Hiding the real error from staff | Low | Staff see a plain sentence; the cause is in the log (`console.error`) and the audit entry has the reason. |
| Reload held back | Low | A tab with a students dialog open stays on the old build until the dialog is closed (same as with an email open). |
| Time limit on requests | Low | 45 s is far above the normal second per line and below nginx's 60 s; a very slow Migadu day shows "did not answer in time" and the clerk retries. |
| Backend restart on deploy | Low | Logins live in PostgreSQL; the live-update stream reconnects by itself. |
| Rollback | Very low | `git revert`, restart, rebuild. |

Overall risk: **low**.

## Step 41 — Students dialogs no longer close when the mouse leaves the card

**Status: DEPLOYED 2026-10-08** at `bd5d0d3` (user authorized, "asap"). Frontend only: `git pull --ff-only`
and `npm run build` in `frontend/` on prod (new bundle `index-p5lXeLTT.js`); the backend service was NOT
restarted (still running since 07:28:30 UTC), so no logins or live-update streams were dropped. Verified:
the page serves the new bundle, `/api/threads` without a login answers 401, service and nginx active. The
owner had checked the UI locally first. Change (`frontend/src/ManageStudents.tsx`, `App.css`): During a client demo the Add students dialog disappeared (the page
behind was fine). Cause: the dialog closed on any click on the dark area around it (`event.target ===
event.currentTarget`), and the browser reports that click when the mouse is pressed inside the card and
released outside (for example while selecting text in the result table), so the dialog and its results were
lost. No server errors or 5xx were found for that period (checked in nginx and the backend log). Fix: a click
outside no longer closes either dialog (Search students and Add students share the component); only the ×
button and Escape close it, and Escape is still ignored while an add is running.

- **Add students hint reworded** (same step, the owner's wording, for clerks): "Type one student per line:"
  then `<student name>,<application number>`, then three lines: Name - full name with only uppercase and
  lowercase letters (Eg Rohit Kumar Khanna); the comma ( , ) is required after that; Application number -
  only numbers, no letters (Eg 1423423). The grey placeholder in the box no longer starts with a
  `Student Name,Application No` header line (it looked like something to type) and shows two example
  students instead; a pasted header line is still recognised and skipped.
- Not covered by an automated test (no frontend component test setup); the owner checks by pressing in the
  card, dragging out and releasing on the dark area, and by clicking outside: nothing should close.
- Whole backend suite unchanged (197 of 197); frontend type check and build pass.
- Deploy: `git pull --ff-only` and `npm run build` in `frontend/`; no backend restart. Rollback:
  `git revert`, rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Closing the dialog | Low | Staff who click outside to close must now use the × or Escape; the × is in the dialog header. |
| Lost results | Lower than before | A stray click or a drag out of the card can no longer lose the result table. |
| Data and backend | None | Frontend only; no API, schema or restart. |
| Open tabs on deploy | Low | Tabs with no thread open reload onto the new build; a tab with a thread open keeps the old behaviour until closed. |
| Rollback | Very low | `git revert`, rebuild the frontend. |

Overall risk: **very low**.

## Step 40 — Add students: a repeated Application No is flagged in the box

**Status: DEPLOYED 2026-10-08** at `8ad99a5` (user authorized). Frontend only: `git pull --ff-only` and
`npm run build` in `frontend/` on prod (new bundle `index-yy5aRpbc.js`); the backend service was NOT
restarted (still running since 07:28:30 UTC), so no logins or live-update streams were dropped. Verified:
the page serves the new bundle, `/api/threads` without a login answers 401, service and nginx active. The
assistant did not use a browser; the owner checks it with two lines sharing a number.
Change (`frontend/src/studentLines.ts`):
Before this, a number repeated inside one paste was only caught after pressing Add (the server skipped
the second line as "Skipped"). Now the box flags the **later** line in red, as the clerk types, with the
Add button off: "The Application No 10012345 is already on line 1 (John Roe). Fix one of them." With three
lines sharing a number, lines 2 and 3 are flagged, both pointing at line 1. Numbers are compared as numbers
(`007` and `7` count as the same). A line already flagged for something else shows that error first, and
its number still counts for later lines. Line numbers count blank lines and the header, like the box.

- Not covered: a number already used by a student in the database. The box cannot know that; it still
  shows as Skipped after pressing Add, naming the student who has it. Catching it in the box would need a
  server look-up (a check step or a call as the clerk types), left for later.
- The server is unchanged and still skips a repeat within a paste as a safety net (it compares the text,
  so `007` and `7` are different there; the box blocks that case first).
- Tests: `backend/tests/studentLines.test.mjs` is now 21 tests (6 new: later line only with the earlier
  line named, three lines, 007 vs 7 and different numbers, blank lines and header, another error first and
  the number still reserved, fixing clears it). Whole backend suite **197 of 197**; backend and frontend
  type checks and the frontend build pass. The red display itself is not covered by an automated test (no
  frontend component test setup); it uses the same list as the other box errors.
- Deploy: `git pull --ff-only` and `npm run build` in `frontend/`; no backend restart. Rollback:
  `git revert`, rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Wrongly blocking a good paste | Low | Only an exact repeat of the same whole number inside one paste is flagged; the clerk fixes or removes one line. `007` vs `7` is treated as a repeat on purpose. |
| Data and backend | None | Frontend only; no API, schema or restart. |
| Duplicates against the database | Unchanged | Still caught by the server after pressing Add (Skipped, with the owner's name). |
| Open tabs on deploy | Low | Tabs with no thread open reload onto the new build; a tab with a thread open keeps the old check until closed. |
| Rollback | Very low | `git revert`, rebuild the frontend. |

Overall risk: **very low**.

## Step 39 — Search students and Add students as two buttons, two dialogs; clerk-friendly input

**Status: DEPLOYED 2026-10-08 07:28 UTC** at `2933728` (user authorized). Deploy was `git pull --ff-only`,
`npm run build` in `frontend/` (new bundle `index-BZLruZRy.js`), then a restart of `student-mail.service`
(backend code changed); no backup and no migration, because there is no database change, and the Migadu
settings were already in prod's `.env`. Verified: service and nginx active, the page serves the new bundle,
`/api/threads` and `/api/students/auto-add` both answer 401 without a login (so the route exists), the
live-update stream reconnected at once (sessions are in PostgreSQL, nobody logged out), sync passes "no new
messages", the only journal warning is the normal stop (status 143). The assistant did not add a student on
prod, so no mailbox was created there; the first real add by staff is the live test. The single "Find/Add
Students" button in the console header became two buttons, **Search students** and **Add students**. Each
opens its own dialog (the same `ManageStudents` component, now taking `mode: "search" | "add"`), titled
"Search students" or "Add students", and the tab switch inside the dialog is gone. The roster and the add
flow behave exactly as before; only the way in changed.

- `frontend/src/Console.tsx`: one state (`studentsDialog`: null, "search" or "add") replaces the on/off flag;
  two header buttons. When a college has no students the console still opens a student dialog on its own
  at first load, now the **Add** one (the owner said such a college will not really happen).
- `frontend/src/ManageStudents.tsx`: `mode` prop, `rosterTab` derived from it, tab buttons removed, dialog
  title follows the mode. In Add mode the roster is not loaded (as before when the Add tab was open).
- `frontend/src/App.css`: the unused `.view-switch` rules removed.
- **Clerk-friendly input** (same step, the users are clerks): the Add students hint says "Type one student
  per line: the name, then a **comma**, then the Application No. The comma is required." with the example
  `Jane Doe,10012345`. The comma is **required**: a space or a tab instead of it is flagged, never guessed
  at (a wrong guess would create a real mailbox for the wrong name); spaces around the comma and a quoted
  name containing a comma are fine; the header line is optional. The Application No must be a **whole
  positive number, digits only** (no letters, decimals, signs, spaces or all zeros; leading zeros are fine,
  every existing one is 5 to 8 digits). A line like `KHAN, ALI 32299` (surname, comma, first name) is
  refused, not turned into a mailbox for the wrong name.
- **Line format, exactly** (box and server alike): one line per student, **exactly one comma**, with the name
  before it and the whole-number Application No after it. The name can be **any number of words** (four or
  five are fine, e.g. `Bankim chandar das chatterjee`); the address uses the first and last word. Spaces
  before the name, before or after the comma, and after the number are ignored (including non-breaking
  spaces), and lines may end Windows-style (CRLF), Unix-style (LF) or old Mac style (CR), mixed or not.
  There is no quote handling: `"Khan, Ali",20` has two commas and is refused.
- **Name rule**: a name is words of **letters only (A-Z, a-z) separated by spaces**, for first, middle and
  last names alike (upper or lower case); digits, dots, hyphens, apostrophes, accents and other symbols
  are refused, in the box and on the server. Checked against prod on 2026-10-08 before adding it: all 2,267
  real students already have names that are letters and single spaces (94 are a single word), so no real
  name is blocked. If a genuine name ever needs a hyphen or an accent, the pattern in
  `studentLines.ts` and `autoAdd.ts` has to change in both places.
- **Checked in the box before sending** (`frontend/src/studentLines.ts`, same rules as the server): as the
  clerk types, every bad line is listed in red under the box with its line number, the text as typed and
  what is wrong (no comma, more than one comma, name or number missing, name with anything but letters and spaces, number not a whole positive number,
  more than 10 lines), the box gets a red border, and **the Add button stays off until every line is
  right** (one bad line among ten is enough). The server still re-checks everything.
- **Live results with one retry at the end** (same step): pressing Add moves the lines out of the box into a
  result table straight away, one row per student showing only the **name and Application No** (no email
  yet). Lines are sent **one at a time, in order** (one request per line to `POST /api/students/auto-add`,
  so each request takes about a second and none can approach nginx's 60 s limit). Each row is **Waiting**,
  then **Trying to add...** (spinner), then **Added** (the email appears only now), **Skipped** or
  **Failed** with the reason, updated as each answer arrives. When every line has been tried once, the
  lines that **failed get exactly one automatic retry**, shown as **Retrying...** and then updated to Added
  or Failed. A retry is a new request, so it looks the addresses up again: an address that was taken in
  the meantime gets the next number (the `x.y1` "new email id"); a line that failed for another reason
  tries the same address again. There is no other retry (the server makes one create per line) and no
  Retry button; lines still failing after the retry go back into the box with a note, to fix and add
  again. Closing the dialog stops the remaining lines from being sent. **Copy data** copies the added rows as a CSV
  (header `Student Name,College,Application No,Email`, then one comma-separated line per student, with the
  college the operator is logged into; no password).
- **Taken addresses** (same step): before creating, an address is looked up in Migadu itself (so mailboxes
  made by hand earlier, not in our `students` table, are found), in our table, and among the lines of the
  paste; the first free one of `x.y`, `x.y1`, `x.y2` ... is used. Migadu answers a create for an address that
  exists with a plain `400 "bad request"` (checked 2026-10-08), the same as other bad requests, so the
  reason cannot be told apart; the one automatic retry above covers it. Known gap: if a create timed out
  after Migadu had actually made the mailbox, the retry makes a second one (`x.y1`) and the first
  (`x.y`) is left over. When the skipped address exists in Migadu but not in our list, the row says so
  ("... already exists in Migadu but is not in our student list ... If that is this student's own mailbox,
  tell the owner"), because a clerk may be adding someone whose mailbox was made by hand.
- The result panel no longer says anything about the mailbox password (clerks should not see it); the hint
  does not mention it either. The password itself is unchanged (`password`).
- Tests: `backend/tests/autoAdd.test.mjs` grew from 18 to 34 tests (comma forms, space and tab flagged, more
  than one comma, surname-comma lines, letters / decimals / signs / zero refused, leading zeros accepted,
  header, `source` kept, taken addresses in Migadu only / in our table only, one create per request, and a
  second request for the same line takes the next number). New `backend/tests/studentLines.test.mjs` (15 tests: empty box, good lines, space
  and tab flagged with line numbers, each kind of error, the limit, the line text, one bad line among ten,
  and a parity test that the box and the server agree on which lines are wrong). Whole backend suite
  **191 of 191**; backend and frontend type checks and the frontend build pass. Not tried in a browser by
  the assistant; the owner checks both buttons, the red error list and the live result rows (the row
  updates and the retry pass have no automated test: the frontend has no component test setup).
- Deploy: `git pull --ff-only`, `npm run build` in `frontend/`, and a **backend restart** (the line parsing
  is backend code; sessions are in PostgreSQL so nobody is logged out). Rollback: `git revert`, restart,
  rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Behaviour | Low | Same component and same flows; the entry point and dialog title changed, and a line is now also accepted with a space or tab between name and number. |
| Wrong mailbox from sloppy input | Lower than before | The comma is required and the Application No must be a whole positive number, so a space-separated line, a surname-comma line or a misplaced word is refused instead of creating a mailbox. The box flags it in red and keeps Add off before anything is sent, and the server re-checks. |
| Box and server rules drifting apart | Low | The same rules live in two places (`studentLines.ts`, `autoAdd.ts`); a parity test fails if they disagree. The server is the authority. |
| Staff habits | Low | The old "Find/Add Students" button is gone; staff look for one of two clearly named buttons. |
| Header space | Low | One more button in the header bar; it wraps on narrow windows like the others. |
| Data and backend | Low | No schema or API change; one backend file changed (line parsing), so the backend restarts on deploy and logins and live updates reconnect. |
| Open tabs on deploy | Low | Tabs with no thread open reload onto the new build; a tab with a thread open keeps the old header until closed. |
| Rollback | Very low | `git revert`, rebuild the frontend. |

Overall risk: **low**.

## Step 38 — Add students: simpler hint text

**Status: DEPLOYED 2026-10-08** at `120e215` (user authorized). Frontend only: `git pull --ff-only` and
`npm run build` in `frontend/` on prod (new bundle `index-DPLWEBtg.js`); the backend service was NOT restarted
(still running since 06:43:22 UTC), so no logins or live-update streams were dropped. Verified: the page
serves the new bundle, `/api/threads` without a login answers 401, service and nginx active. Change: the hint under the format on the Add
students tab no longer mentions the password, and "10 students at a time" is bold
(`frontend/src/ManageStudents.tsx`). Behaviour is unchanged; the result panel's note about the password was
left as it was. Whole backend suite 160 of 160; backend and frontend type checks and the frontend build pass.
Deploy: `git pull --ff-only` and `npm run build` in `frontend/`; no backend restart. Rollback: `git revert`,
rebuild.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Behaviour | None | Text and one bold tag only; no logic, API or data change. |
| Logins and live updates | None | No backend restart. |
| Open tabs on deploy | Low | Tabs with no thread open reload onto the new build; a tab with a thread open keeps the old text until closed. |
| Rollback | Very low | `git revert`, rebuild the frontend. |

Overall risk: **very low**.

## Step 37 — Add students from a name and Application No (Migadu mailbox created automatically)

**Status: DEPLOYED 2026-10-08 06:43 UTC** at `35ceef4` (user authorized). Deploy was `git pull --ff-only`,
`npm run build` in `frontend/` (new bundle `index-BhZ1pHdX.js`), then a restart of `student-mail.service`; no
backup and no migration, because there is no database change; the Migadu settings were already in prod's
`.env`. Verified: service and nginx active, the page serves the new bundle, `/api/threads` and the new
`/api/students/auto-add` both answer 401 without a login (so the route exists), the live-update streams
reconnected at once (sessions are in PostgreSQL, nobody logged out), sync passes "no new messages", the only
journal warning is the normal stop (status 143). The assistant did not run a real add on prod, so no
mailbox was created there; the first real add by staff is the live test. Client request: staff paste only
`Student Name,Application No`; the console creates the Migadu mailbox and the student record and shows the
new emails. Replaces the old five-column paste in the Add students tab (the old `/api/students/import`
route and `importStudents` are left in place, now unused by the UI).

- Email rule (owner's): first word + "." + last word of the name, lowercase, plain a-z/0-9 (accents folded,
  other symbols dropped); one-word name = that word; if the address exists in Migadu or in `students`, a
  number is added after the name (`x.y1`, `x.y2` ...). Password is `password`, year is the current UTC year.
- `backend/src/migadu.ts` (new): Migadu API client (exists / create / remove), Basic auth with
  `MIGADU_ADMIN_EMAIL` + `MIGADU_API_KEY` (both already set in prod `.env`; `MIGADU_DOMAIN` optional,
  default `myemailinfo.com`). 15 s timeout per call. Earlier note about a "mailbox limit for unverified
  accounts" 403 no longer applies: a mailbox was created through the API on 2026-10-08.
- `backend/src/studentEmail.ts` (new): the address rule. `backend/src/autoAdd.ts` (new): per line, in
  order: skip if the Application No is already used in this college (or twice in the paste), find a free
  address, create the mailbox, save the student; if saving fails the mailbox is removed again. A line that
  fails touches nothing else. Max 10 lines per request (measured on 2026-10-08: about 0.8 s per line, 5 lines in
  4.1 s; lines are deliberately handled one after another because Migadu publishes no rate limits). `students.ts`: `parseCsvLine` and `splitName`
  exported. `server.ts`: `POST /api/students/auto-add`.
- Frontend: Add students tab takes two columns and shows counts plus a table (added / skipped / failed with
  the reason, the email created, Copy data); failed lines stay in the box for a retry.
  `types.ts`, `api.ts`, `ManageStudents.tsx`, `App.css`.
- Assumptions made without an answer from the owner: any logged-in staff member can use it; a duplicate
  Application No is skipped (not an error); lines are handled one after another.
- Not done: forwarding to the central mailbox is not set (the Migadu API shows an empty forwarding list for
  existing students too); the console reads the student's own mailbox on search regardless.
- **Tried for real on 2026-10-08** (script on the backend code, local dev database, real Migadu account): the
  paste `TEST ZETA,990001 / TEST ZETA,990002 / TEST ZETA OTHER,990001 / TEST,` gave `test.zeta@` and
  `test.zeta1@myemailinfo.com` (second one with the "number added after the name" note), one skip (repeated
  Application No) and one failure (missing Application No). Both Migadu mailboxes were active and an IMAP
  login with `password` worked; the two local rows had first name TEST, last name ZETA, college 3, central
  `central.ksma@`, year 2026. Those two test mailboxes (`test.zeta`, `test.zeta1`) and the two local
  student rows (Application Nos 990001, 990002) were left in place; remove them in Migadu and locally if
  not wanted. The screen itself was opened in a browser by the owner, not the assistant.
- Local dev servers: backend `cd backend && npx tsx src/server.ts` (API on :3001), frontend
  `cd frontend && npm run dev` (http://localhost:5173).
- Tests: `backend/tests/autoAdd.test.mjs` (18 tests, fake database and fake Migadu: address rule, numbers
  after taken names in Migadu or in our table, skipped Application Nos, per-line failures that do not stop
  the next line, mailbox removed again when saving fails (and a failed removal still reports the failure),
  all 50 candidate addresses taken, header optional in any case, CRLF and quoted names, tidied spaces,
  names with symbols refused, counts add up, 10-line limit) and `backend/tests/migadu.test.mjs` (9 tests, fake
  fetch: missing credentials, default and custom domain, 200/404/other on lookup, Basic auth and URL,
  create body, refusal message without credentials, no-JSON answer, delete incl. 404, URL encoding).
  Whole backend suite **160 of 160** (none skipped, database tests included); backend and frontend type
  checks and the frontend build pass.
- Deploy needs a backend restart and a frontend rebuild; no database change. Rollback: `git revert`,
  restart, rebuild. Mailboxes already created in Migadu stay (remove in Migadu if needed).

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Migadu mailboxes | Medium | Every added line creates a real mailbox that cannot be undone by the console (only a failed save removes it). A wrong name or Application No means a wrong mailbox to remove by hand. |
| Who can use it | Medium | Any logged-in staff member can now create mailboxes. No extra permission was added. |
| Weak password | Medium | `password` is the mailbox password for every new student, reachable over IMAP (the owner's rule). |
| Data and database | Low | Same INSERT the old import used; no schema change. Duplicates are skipped by Application No and address. |
| Concurrency | Low | Two staff adding the same name at once could pick the same address; the second Migadu create fails and that line is reported failed. |
| Retry after an interrupted request | Medium | A failed line gets one automatic retry at the end of the results (a new request that looks the addresses up again). If a call timed out after Migadu had already created the mailbox, the retry makes `x.y1` and leaves an orphan `x.y`. A safeguard (look the address up before retrying) is possible but not built. |
| Slow requests | Low | Up to 10 lines at about 0.8 s each (about 8 s); nginx cuts a request at 60 s, so there is room even if Migadu is several times slower. Not parallelised on purpose: no published Migadu rate limits and a flag on the only account would be costly. |
| Existing import | Very low | Old import route and function untouched, now unused by the UI. |
| Rollback | Low | `git revert`, restart, rebuild; created mailboxes remain. |

Overall risk: **medium** (external side effects and no extra permission), code risk low.

## Step 36 — Reason line on rejected rows in the message list

**Status: DEPLOYED 2026-10-08 04:04 UTC** at `e8f1f60` (user authorized). Checked in and pushed first.
Deploy was `git pull --ff-only`, `npm run build` in `frontend/` (new bundle `index-CUEqY9xv.js`), then a
restart of `student-mail.service`; no backup, because there is no database change. Verified: service and
nginx active, the page serves the new bundle, `/api/threads` without a login still answers 401, the open
consoles' live-update streams reconnected right away (sessions are in PostgreSQL, nobody logged out),
sync passes "no new messages", the only journal warning is the normal stop (status 143). The assistant did
not use a browser; the user checks that the Reason line shows on rejected rows.

Rejected threads now show one more line in the list: `Reason: <the reviewer's note>`, muted, one line,
shortened with an ellipsis (full text on hover). It appears only when the rejection email has a real note;
a note that is only a placeholder (like "1") shows nothing, and other badges are unchanged. The opened
thread already showed the same text in its Reason box.

- `backend/src/thread.ts`: `ThreadSummary.reject_reason`, filled by `rejectReason()` from the newest
  rejection email in the thread (the same `classifyEdugate` the thread view uses). Null unless the badge is
  `rejected`. No schema change: the note is parsed from the stored body each time the list loads.
- `frontend/src/types.ts`, `MessageList.tsx`, `App.css`: the field, the line, and its style.
- `shared/edugate.ts`: the rule that cuts Edugate's WhatsApp contact sentence from a note expected
  `WhatsApp at:` with a colon, but real emails also write `WhatsApp at +996 ...` without it, so that
  sentence still showed (seen on application 30560). The colon is now optional. This also cleans the
  Reason box in the opened thread.
- Tests: `backend/tests/rejectReason.test.mjs` (3 tests: sentence cut with and without the colon; a note with
  no letters gives no reason). Whole backend suite **133 of 133**; backend and frontend type checks and the
  frontend build pass. Not tried in a browser by the assistant; the user checked it locally.
- Deploy needs a backend restart (new field in the list response) plus a frontend rebuild. Sessions are in
  PostgreSQL, so nobody is logged out; the live-update stream reconnects by itself. Rollback: `git revert`,
  restart the backend, rebuild the frontend.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Data and database | None | No schema, migration or stored-data change; the note is read from existing bodies. |
| List response | Very low | One new field on each list row. Old open tabs ignore it until they reload onto the new build. |
| Parser change | Low | The WhatsApp rule only got a looser match. A wrong match could cut a few words of a note, and the full email is untouched. |
| List speed | Very low | One extra parse of the rejection email per rejected thread, using the parser the list already runs for titles. |
| Logins and live updates | Very low | Backend restart drops the live stream for a moment; the console reconnects, no one is logged out. |
| Staff work in progress | Very low | Open tabs reload onto the new build only when no thread is open. |
| Rollback | Very low | `git revert`, restart, rebuild. Nothing to undo in the database. |

Overall risk: **low**.

## Step 35 — Signed out in another tab: show Login, not "(401)" errors

**Status: DEPLOYED 2026-10-01** at `dcf1ca0` (user authorized). Frontend only: `git pull --ff-only`
and `npm run build` in `frontend/` on prod (new bundle `index-Toxloqu_.js`); the backend service was
NOT restarted (still running since 08:06:57 UTC), so no logins or live-update streams were dropped.
Verified: the page serves the new bundle, the asset downloads, `/api/threads` without a login still
answers 401, service and nginx active, 0 warnings in the journal. Open tabs pick the new build up
through `useNewVersionAvailable`. The assistant did not use a browser; the user checks with two tabs.

Two tabs share one login
cookie. Signing out in one deletes the session row in PostgreSQL, so the other tab is signed out
on the server too. Its page did not know: the live-update stream stays connected (only a stream
that gives up triggers the old signed-out handling in `subscribeToUpdates`), and its next fetch
failed with a raw "Failed to load threads (401)" error while the console kept looking normal.

- New `frontend/src/apiFetch.ts`: `apiFetch` is `fetch` plus one rule: a 401 calls the registered
  "session ended" handler, then the response is returned unchanged (callers still see the 401, but
  by then the app is on the Login screen). `App.tsx` registers a handler that clears the session,
  so any logged-in call that gets a 401 sends the user to Login with no error banner.
- 12 call sites in `frontend/src/api.ts` use `apiFetch` (threads, thread, mail check and match,
  reply, follow-up, students, import, admin students, mark handled, code alerts, system status,
  select college). Login, the session check (`/api/auth/me`), logout and the colleges list stay on
  plain `fetch`: login's 401 means "wrong password" and the session check expects a 401.
- Every 401 in `server.ts` means "no valid session" (`requireAuth`, `/api/auth/me`, a college-select
  race, and login's wrong password), so a 401 never ends a session by mistake.
- **No database or backend change; no backend restart.** Frontend rebuild only. Open tabs keep the
  old code until `useNewVersionAvailable` reloads them (only when no thread is open; the search text
  is kept). Rollback: `git revert`, rebuild the frontend.
- Tests: `backend/tests/apiFetch.test.mjs` (6 tests: a 401 is reported and the response still
  returned; 200-502 do not end the session; several 401s are each handled; no handler is fine;
  request passed through and network errors still thrown; unregistering a replaced handler keeps
  the newer one). Whole backend suite **130 of 130**; backend and frontend type checks and the
  frontend build pass.
- **Not done (left out on purpose):** a tab that is signed out in the background and makes no
  request stays on the console screen until its next request gets a 401. Making that instant needs
  a cross-tab signal (a `localStorage` "signed out" marker the other tabs listen for) or closing
  the live-update stream on logout. Not needed for the ugly-errors fix; the user may ask later.
- Not tried in a browser by the assistant; the user checks with two tabs: sign out in one, then
  search or click in the other and expect the Login screen with no error banner.

**Risk analysis**

| Area | Risk | Why |
|---|---|---|
| Data and database | None | Frontend only. No backend, schema or data change. |
| Logins and open sessions | None | Sessions are stored in PostgreSQL and the backend is not restarted. |
| Wrongly sending someone to Login | Very low | The backend only answers 401 when the session is gone, and only logged-in calls use the wrapper. |
| Login flow | Very low | Login, the session check, logout and the colleges list are unchanged. |
| Open tabs on deploy | Low | Old tabs keep running the old code until `useNewVersionAvailable` reloads them (no thread open; search text kept). |
| Staff work in progress | Very low | A tab with a thread open is never auto-reloaded, so copying a code is not interrupted. |
| Rollback | Very low | `git revert`, rebuild the frontend. Nothing to undo in the database. |
| Residual gap | Cosmetic | An idle background tab stays stale until its next request. |

Overall risk: **low**.

## Step 34 — Flexible student search (words in any order, partial, any case)

**Status: DEPLOYED 2026-10-01 08:06 UTC** at `919808c` (user authorized). Checked in and pushed first.
Deploy was `git pull --ff-only` and a restart of `student-mail.service`; no backup, because there is no
database change. Verified: service active, IMAP watcher reconnected, the open consoles' live-update
streams reconnected within about 2 s (sessions live in PostgreSQL, so nobody was logged out), sync
normal, 0 errors after the restart. The old process's stop line "Failed with result 'exit-code'"
(status 143, the normal stop signal) also appears on earlier deploys. The new query shape was run
read-only on prod: "ali kha" and "kha ali" both returned the same 7 students. The assistant did
not use the search boxes in a browser; the user checks them.

Built and tested locally first. Both search bars used to
match the whole typed text as one substring, so "MOHD KHAN" missed "MOHD FARMAN KHAN" and a
reversed order matched nothing. The typed text is now split on whitespace and every word must
appear (case-insensitive, partial) in the same searchable text as before: first name, last name,
email, central email, college and admission ID. So `MOHD KHAN`, `FARMAN MOHD KHAN`,
`farman mohd khan` and `farma moh kha` all find MOHD FARMAN KHAN.

- New `backend/src/searchTerms.ts` (`searchPatterns`, `searchClause`) is used by the three
  queries: `findMatchingStudentEmails` and `findSearchMatches` in `thread.ts` (console list and
  the automatic mailbox check) and `searchAdminStudents` in `studentsAdmin.ts` (Students dialog).
- At most 10 words are used (`MAX_SEARCH_WORDS`): 8,000 words took 12 s on the dev database,
  while real searches have 5-6. Blank text still builds a valid query.
- The Students dialog search now escapes `%` and `_` like the console search (it did not before).
- **No database change:** no migration, no schema change, read-only queries only. The
  `idx_students_search_trgm` index expression is unchanged. Frontend untouched, no rebuild.
- Tests: `tests/nameSearch.db.test.mjs` (28 real-database tests: the example forms, reversed and
  mixed-case order, extra spaces, single word, email and admission-ID search, literal `%`/`_`,
  no match, dialog counts, console list, mixed name + email or admission ID, the word cap, blank text). Whole backend suite **124 of 124**; backend and frontend
  type checks and the frontend build pass.
- Also tried the real functions read-only against the local dev database (2,281 students):
  full, reversed, upper-case and abbreviated names all found the same student in both searches.
- Deploy: `git pull --ff-only` and restart `student-mail.service`; nothing else. Rollback:
  `git revert` and restart. Behavior note: a word can match anywhere in the combined text,
  including the email, as a single word always could.
- **Future step (not built): search that tolerates mistyped names** ("farmn" finding
  "farman"). No new extension is needed: `pg_trgm` is already installed and provides
  `similarity()` and `word_similarity()`. Neither `pg_search` nor built-in `tsvector` full-text
  search is wanted: `tsvector` matches whole words or word prefixes, not the middle of a word, and
  `pg_search` is a separate install on prod. Open design points: a similarity threshold, ranking
  closest matches first, and keeping the exact-word match as the first choice so a normal search
  never gets noisier results. Raised by the user 2026-10-01; do it later, after Step 34 is live.

## Step 31d — Opening a thread reads one student, in one snapshot

**Status: DEPLOYED 2026-09-29 22:57 UTC** at `10142ca` (user authorized). Fresh backup first (server
`student_mail-20260929T225648Z.dump`, S3, local `~/backups`), `git pull --ff-only`, migration
`016_replies_student_index.sql` (index created), restart. Verified: service active, IMAP watcher
and SSE reconnected, sync normal, 0 errors after the restart; the new thread-open queries were
run read-only on prod inside a `REPEATABLE READ READ ONLY` transaction for a real message (about
1 ms each; the planner still chooses a sequential scan on `replies` because the table has one row -
the index takes over as it grows). Based on `4b8e68e`. Two changes:

1. `fetchThread` (`backend/src/thread.ts`) used to load the whole mailbox (every visible
   message with its body, plus every reply) and pick one thread out of it. Threads never
   span students, so it now reads only the clicked message's student: an owner lookup
   (message in this operator's mailbox, student active and in the selected college), then
   that student's messages and replies. All reads, including the Edugate login and
   unknown-template lookups, run in one `REPEATABLE READ READ ONLY` transaction on one
   client, so the access check and the content cannot disagree if the student is moved or
   deleted mid-request (before, the check and later reads were separate statements). A
   failed `ROLLBACK` no longer hides the original error. The console list
   (`fetchThreadSummaries`) is unchanged.
2. Migration `016_replies_student_index.sql` adds `idx_replies_student_email`, so the
   per-student replies read is an index lookup. Index only; safe to re-run; harmless to
   the old code. `schema.sql` includes it.

**Tests:** new `tests/threadOpen.db.test.mjs` (20 real-database tests): whole-thread
opening from any message, separate threads per student and per Message-ID, replies only
in their own thread, unknown / other-college / other-mailbox / deleted-student opens
nothing, the login/registration/rejection warnings, a snapshot test that moves the
student between the owner lookup and the later reads, the index existing and being safe
to re-create twice, and an index-usage plan check. Checked against the previous
`fetchThread`: 19 of the 20 pass on both versions (same answers as before) and only the
snapshot test fails on the old one. Whole backend suite on PostgreSQL 18: **96 of 96**
pass; backend and frontend type checks pass.

**Honest value note:** measured on prod (see the deploy record above), opening a thread
costs ~26 ms server-side, so this is protection for growth and for the access race, not a
speed-up anyone will feel today.

**Deploy order used (kept for re-deploys):** fresh backup (server, S3 via `backup-db.sh`,
local); `git pull --ff-only`; apply `016_replies_student_index.sql`; restart
`student-mail.service`. The index can be applied before or after the code (old code
ignores it). Rollback: `git revert` and restart.

## Step 31a — UID reset safety fix (checked in; deployed 2026-09-29 22:39 UTC)

Built in a separate worktree from `fe40491`; the existing Steps 31–33 working tree
is unchanged. This small slice fixes `syncInbox` after an IMAP UIDVALIDITY change:
its new watermark starts at zero rather than carrying the old mailbox's UID.
A focused fake-mail-server test first failed with saved UID 500 instead of 1,
then passed after the fix. Two small mail utility tests cover reply HTML
sanitization/list numbering and Migadu delay detection. All 44 backend tests
pass; backend TypeScript checking and the frontend build passed before the
two test-only additions.

Coverage is a quality measure, not a check-in blocker (user clarification on
2026-09-29). Measured against the old code, the 44 tests cover 55.8% of lines,
74.6% of branches, and 80.2% of functions (up from 53.9% / 73.2% / 77.7%
with 42 tests). The later target for the expanded suite is 85% / 80% / 85%.
Coverage tooling and the load test belong with the tests and features they
describe. The README and diagrams were committed separately as `806efa5`.
Both commits are on GitHub. Deployed together with 31b and 31c (see the deploy record above).

## Step 31b — lowercase email rule and lookup indexes

Checked in as `c3657e6` (based on `806efa5`), pushed with 31c, DEPLOYED 2026-09-29 22:39 UTC. Migration 014 adds six indexes for
student/message lookups, roster order, the hot list and sweep. It also adds
triggers that lowercase newly written student and message addresses, backed by
CHECK constraints; existing mixed-case rows stop the migration with a count
for each table. `backend/schema.sql` includes the same indexes, triggers and
constraints for fresh installs.

A real-PostgreSQL test checks the mixed-case preflight and rollback, two safe
runs of the migration, normalized new writes, duplicate refusal, and index
plans for the two `lower(email)` lookups. A fresh-schema test checks the
constraints and trigger. Migration 014 also applied successfully to the exact
`fe40491` schema in a separate scratch database. All 46 backend tests pass,
backend TypeScript checking passes, and the frontend builds. No production
database was touched. Coverage on this staged code is 55.8% lines, 74.6% branches, and 80.2%
functions. It is a quality measure, not a check-in blocker.

## Step 31c — cached Edugate rejection date and roster counts

Checked in as `c14d2de`, pushed, DEPLOYED 2026-09-29 22:39 UTC (migration 015 backfilled 34 students). Based on `c3657e6` (31b). Migration 015 adds
`students.rejected_at`, backfills the latest rejection email, and adds a
covering roster-state index. Message correction/deletion triggers recompute
code, login and rejection dates; changing a student's email refreshes its
rejection date. The fresh-install schema mirrors the migration. The backend
records new rejection mail in the same transaction as the message, and the
Students dialog classifies status from the students table without reading
messages. The Step 32 thread-summary code is not part of this slice.

Verification: migration 015 applied twice to the exact `c3657e6` schema in a
throwaway PostgreSQL instance and backfilled a rejection. Five new database
tests cover backfill/idempotence, the event path, corrected/deleted mail,
mail moved between students, and student email changes. The existing four
registration tests and twenty real-database roster tests also pass on this
slice; the mail-ingestion rollback test now includes a rejection. All 76
backend tests pass, backend TypeScript checking passes, and the frontend
build succeeds. Informational coverage: 55.7% lines, 75.2% branches, 80.6%
functions. The full 10x load test belongs to the later thread-summary slice;
PostgreSQL may choose a different available roster index on a small dataset.
No production database was touched.

**Deploy order (important):** take a fresh backup (server, S3, local), apply
`015_rejected_at.sql`, and only then pull and restart the backend. The new
`applyRegistrationEvent` writes `rejected_at` for every code, login and
rejection email; if the code runs before the column exists, each of those
updates fails, rolls back the message insert, and mail sync retries and stalls
for those emails. Before applying, re-run the read-only checks: no student
with a registered date/status lacking a login email, and none with a code date
lacking a code email (the 015 triggers clear cached dates when their last
supporting Edugate mail is deleted or corrected; a state set some other way
would be cleared on such a delete). On the 2026-09-29 backup both counts were 0.
Rollback: `git revert` and restart; the column, index and triggers are
additive and harmless to the old code.

## Agreed TODO plan (2026-09-21)

HISTORICAL (written 2026-09-21; the current state is in "Start here" at the top).
This section records the user's reviewed target plan, not implemented behavior.
It supersedes older roadmap assumptions where they conflict. The existing
implementation and historical notes below remain useful context. Steps 0–5
have been authorized and completed. Stop for confirmation before Step 6 or any
later step (that was true on the day; later steps are done, see the step index). Do not treat approval of this plan as blanket implementation or
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
  entered college records named exactly `KRMA CENTRAL`, `IHSM CENTRAL`, and
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
  (confirmed against the real KRMA CENTRAL roster, including the two
  `Sample Student A/B` rows the user had already imported live). Both
  TypeScript checks passed, backend restarted.
- [x] **Step 7/8 — Header-based bulk student CSV import with password
  column.** Merged at implementation time: `students.smtp_password` is
  `NOT NULL`, so Step 7's format alone (no password) couldn't actually
  insert a row - Step 8's password column was required from the start.
  Require exact full college names, with no `KRMA` or `IHSM` aliases.
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
  matches `Test Student 1 KRMA` (admission_id `97299038`); confirmed via
  `EXPLAIN` with `enable_seqscan` forced off that the rebuilt index is a
  valid, usable match for the search expression (a `Bitmap Index Scan` on
  `idx_students_search_trgm`) - it isn't chosen at today's 23-row scale
  (correct planner behavior, not a bug) but will be used automatically
  once the table is larger. Both TypeScript checks passed, backend
  restarted.
- [x] **Step 10 — Diagnose and fix central-inbox-to-UI latency.** The user
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
  Completed 2026-09-21.

  **Diagnosis (measured, not guessed):** added `[TIMING]` logging at every
  stage (IDLE `exists` event, IMAP arrival timestamp, DB insert, SSE
  broadcast) and ran real tests through the actual forwarding chain (test
  students' own stored credentials, and the user's own external Gmail
  send). Every clean test - single message, a 4-message concurrent burst,
  and the user's live Gmail send - completed in **6-12 seconds** end to
  end, contradicting a persistent systemic delay. The user confirmed the
  3-4 minute delay happened once, during yesterday's demo, was reproduced
  by refreshing/re-logging in (so the message genuinely wasn't in Postgres
  yet, not a UI/SSE display issue), and no backend restarts occurred
  during it. This pointed at a real, unfixed gap in `mailboxSync.ts`:
  `triggerSync`'s `runningSync` guard had no timeout, so a single stalled
  IMAP operation (plausible on a live demo network) would hang forever,
  silently blocking **both** future IDLE triggers and the 60-second
  fallback poll for that mailbox until the stall eventually timed out on
  its own and everything caught up at once - matching the "stuck, then
  all at once" pattern reported. Not provable from yesterday's un-logged
  run, but the most plausible explanation for a genuinely reproducible,
  single-mailbox, non-restart-related, minutes-long stall with real
  infrastructure.

  **Fixes implemented:**
  - `mailboxSync.ts`: `triggerSync` now has a 45-second watchdog
    (`withWatchdog`) wrapping `syncInbox()`, so `runningSync` always
    clears within bounded time regardless of what hangs underneath -
    closing the deadlock gap directly. A trigger arriving while a sync is
    already running now sets a `pendingRerun` flag instead of being
    silently dropped; the in-flight sync re-triggers itself immediately
    on completion, so nothing arriving mid-sync has to wait for the next
    IDLE event or poll tick.
  - `server.ts`: the fallback poll interval default dropped from 60s to
    5s. Safe to run this tightly because (a) `triggerSync` is
    fire-and-forget async I/O in a `setInterval`, never awaited, so it
    can't block the event loop or any API request, and (b) syncs are now
    cheap when nothing's new (see below), not an expensive full rescan
    every tick. `.env.example` updated to match.
  - `sync.ts`: rewritten to track a UID watermark (`last_uid`,
    `uid_validity` - new columns on `central_mailboxes`, migration
    `004_step10_sync_improvements.sql`) per mailbox instead of always
    refetching the last 50 messages by sequence number. Every sync after
    the first fetches strictly `UID > last_uid` - whether that's 0, 1, or
    500 new messages, with no ceiling either way - eliminating both the
    correctness ceiling (more than 50 new messages between syncs
    previously meant silent, permanent loss of the overflow) and the
    wasted re-parsing of up to 50 full messages on every tick. First-ever
    sync for a mailbox (no stored watermark) still does the old bounded
    last-50 catch-up as a baseline; a UIDVALIDITY change (rare server-side
    UID reset) is detected and triggers the same bounded catch-up rather
    than fetching from a now-meaningless stored UID.
  - `sync.ts` also fixes the multi-student dedup bug: previously
    `toAddresses.find(...)` kept only the first matching student per IMAP
    message, and `messages.message_id` was globally `UNIQUE`, so a single
    external message addressed to several students (each forwarding
    independently to the central mailbox) only ever got recorded for one
    of them - the rest silently vanished with no error. Migration `004`
    changes the constraint to `UNIQUE(message_id, student_email)`, and
    `sync.ts` now loops over every matching student, inserting one row
    each (`ON CONFLICT (message_id, student_email) DO NOTHING`).
  - `thread.ts`: fixed to match. Since two different students can now
    legitimately share a `message_id`, `groupIntoThreads`'s union-find
    keys were changed to `student_email + message_id` composites (a
    reply/reference chain for one student's copy only ever refers to that
    same student's own messages), and every place that matched replies by
    `incoming_message_id` alone (`fetchThread`, `fetchThreadSummaries`,
    `countEffectivelyPendingByEmail`) now also requires the reply's
    `student_email` to match, closing a cross-student reply-leak that the
    message_id-only matching would otherwise have allowed. A second bug
    was caught during verification (not just assumed fixed): `fetchThread`
    looked up "which group does my target message belong to" using
    `message_id` alone, which could still grab the wrong student's group
    since both groups contain a message with that id - fixed to also
    require `student_email` match.

  **Verification:** both TypeScript checks passed; migration `004`
  applied to the dev database (confirmed via `\d`). Live tests via
  real SMTP sends through the actual student-mailbox forwarding chain
  (not synthetic bypasses): a UID-tracking check (first sync did the
  bounded 21-message catch-up, the very next 5-second poll tick showed
  `skipped=0` with no full rescan, confirming incremental mode); a real
  message to two students at once, confirmed as two separate DB rows via
  direct query and two separate, correctly-isolated threads via
  `fetchThreadSummaries`/`fetchThread` (this is where the second
  `fetchThread` bug above was caught and fixed); and the user's own live
  external Gmail send, which appeared in the UI as expected. All
  synthetic test messages this investigation created were deleted
  afterward; the user's own live test message was left in place. Backend
  restarted with the final code; `central_mailboxes.last_uid`/
  `uid_validity` persisted correctly across that restart.
- [x] **Step 11 — Branding.** User will provide high-resolution ISM Edutech
  and college logos. Landing: ISM Edutech branding plus college buttons.
  Selected-college login and inner/mail pages: ISM Edutech and selected
  college logos, with the selected college's full name.
  Completed 2026-09-21: user supplied 3 logo files (ISM Edutech brand mark,
  a shared IHSM seal used for both IHSM CENTRAL and IHSM ELITE, and a
  KGMA/KRMA seal), saved to `frontend/public/logos/`. Since every place a
  logo appears already shows the full college name as text right next to
  it (CollegePicker buttons, Console header), that existing text is what
  actually disambiguates IHSM CENTRAL from IHSM ELITE sharing one image -
  no image editing/text-overlay was needed. New `branding.ts` maps college
  name to logo path. `CollegePicker.tsx`'s "ISM Edutech" text became the
  actual logo image, each college button got its own logo; `Login.tsx`'s
  text became the ISM Edutech logo (no college logo there - login happens
  before college selection per Step 5's reorder, so no college is known
  yet at that screen); `Console.tsx`'s header got both the ISM Edutech and
  selected-college logos next to the existing text. Verified: frontend
  TypeScript check and production build both passed, and the build output
  confirmed the logo files were correctly bundled into `dist/logos/`.
- [x] **Step 12 — Professional inbox UI.** Preserve consistent full width.
  Use a compact branded header with college and logged-in mailbox, a fixed
  desktop thread-list width and flexible reading pane, clear student
  name/email, subject, preview, timestamp, and selection state. Improve
  message readability and attachment/composer layout; show the student's
  sending address. Retain Pending / Replied labels per the latest approved
  wording, rather than the earlier proposed Handled rename.
  Completed 2026-09-21: much of this was already true before this step -
  `.main-layout` already used a fixed 380px sidebar plus a flexible `1fr`
  reading pane, and Pending/Replied were never touched. What was actually
  missing: (1) the thread list never showed a body preview - added a
  `preview` field to `ThreadSummary`/`fetchThreadSummaries` (derived from
  the representative message's body_text, falling back to stripped
  body_html, truncated to 140 chars) and rendered it in
  `MessageList.tsx`; (2) the composer never visibly stated which student
  mailbox a reply sends from (only implied in placeholder text) - added a
  visible "Replying as: student@domain" label; (3) the attach-files
  control was restructured into a `composer-toolbar` row (built to also
  hold Step 13's Bold/Italic buttons, done in the same pass to avoid
  touching the composer twice). Also reinstated `.app`'s max-width at
  2000px (was `max-width: none`, i.e. fully fluid) - a prior documented
  fix had deliberately capped it at 2000px specifically for message
  readability on ultra-wide monitors, and it had since drifted back to
  unbounded; re-capping it matches this step's explicit readability goal.
  Header branding (logos) landed together with Step 11 in the same pass.
  Verified: frontend TypeScript check and production build both passed.
- [x] **Step 13 — Rich-text composition and native spellchecking.** Add
  Bold and Italic toolbar controls and Ctrl/Cmd+B and Ctrl/Cmd+I shortcuts.
  Preserve formatting in sent mail and conversation history; store/send
  sanitized HTML with a plain-text fallback while retaining attachments
  and threading. Enable browser-native spellcheck in the composer, with
  browser-provided suggestions and manual corrections. Availability varies
  by browser/language. No automatic rewriting or integrated grammar service
  in this scope; grammar-service integration is deferred.
  Completed 2026-09-21: replaced the plain `<textarea>` composer in
  `ThreadView.tsx` with a `contentEditable` div (no new library - matches
  how `linkify.ts` already hand-rolls its own incoming-mail sanitizer
  rather than pulling in a dependency), with Bold/Italic toolbar buttons
  and Ctrl/Cmd+B / Ctrl/Cmd+I shortcuts via `document.execCommand`, and
  `spellCheck={true}` explicit (browsers often default it off for
  `contentEditable` divs).
  The actual security boundary is server-side, not the browser: new
  `sanitizeReplyHtml.ts` strips every tag outside a narrow allowlist
  (`b`/`strong`/`i`/`em`/`br`/`div`) and strips all attributes even on
  allowed tags (so `<b onmouseover=...>` keeps the `<b>` but drops the
  handler) - this matters because a request can reach the reply endpoint
  without ever going through the browser's contentEditable serialization.
  `htmlToPlainText()` derives the plain-text fallback from the
  already-sanitized HTML server-side (not a separately client-supplied
  string), so the two can never disagree. `replies.body_html` added via
  migration `005_reply_body_html.sql` (nullable - older replies keep
  rendering as plain text, no backfill). `reply.ts`'s `sendReply` now
  sends both `text:` and `html:` via nodemailer (previously `text:`
  only) and stores both columns; the `/api/messages/:id/reply` route
  reads a new `bodyHtml` field, sanitizes it, and derives `bodyText` from
  the sanitized result rather than trusting a separate client-supplied
  plain-text field. `ThreadView.tsx`'s outgoing bubbles render
  `body_html` directly when present (already sanitized at write time, so
  not re-run through the incoming-mail sanitizer, which assumes different
  things like unwrapping mailto: links).
  Verified: both TypeScript checks passed. 10 sanitizer scenarios run
  directly (script/img/onmouseover/javascript: URL/case-insensitive BR/
  entity-escaping all handled correctly - one test's own expected value
  was initially wrong, caught and fixed rather than assumed passing), plus
  a real end-to-end reply sent through the actual `sendReply` pipeline
  (real SMTP send via a test student's Migadu credentials) confirming the
  malicious `onclick` attribute was stripped, Bold/Italic markup survived,
  and both `body_text`/`body_html` were stored correctly - the test
  message's replied-state was then reset so the test student's pending
  count wasn't left artificially changed. Production frontend build also
  passed.
  Follow-up 2026-09-21 (user-requested):
  1. Added Underline alongside Bold/Italic - `u` added to
     `sanitizeReplyHtml.ts`'s tag allowlist, a third toolbar button and
     Ctrl/Cmd+U shortcut added to `ThreadView.tsx`. Verified the sanitizer
     keeps `<u>` while still stripping attributes on it (e.g.
     `<u onclick=...>` keeps the tag, drops the handler).
  2. The college named `KSMA CENTRAL` was actually supposed to be
     `KRMA CENTRAL` (a naming error caught after Steps 2-9 already used
     the wrong name). Renamed via new migration
     `006_rename_ksma_to_krma.sql` (applied to the app database):
     `colleges.name`, the 7 KRMA students' `college` free-text column, and
     the "KSMA" abbreviation baked into the 5 test students' `name`/
     `last_name` fields (e.g. "Test Student 1 KSMA" -> "... KRMA").
     `schema.sql`'s seed data and `branding.ts`'s logo-lookup key updated
     to match. Migration `001_colleges.sql` itself was deliberately left
     as historical record (matches the existing convention from Step 4 of
     adding a new migration rather than editing an applied one).
     Deliberately NOT renamed: any mailbox email address
     (`central.ksma@...`, `test.ksma1-5@...`, `sample.ksma.*@...`) - those
     are real provisioned Migadu mailboxes whose addresses are live login
     credentials, not display text; renaming them would mean actually
     recreating the mailboxes at Migadu, a separate real-world action this
     session can't take. All PROJECT.md prose referencing the college name
     was also updated (via a word-boundary-safe replace that only touched
     uppercase `KSMA`, never the lowercase email addresses).
     Verified: the exact `searchAdminStudents` query re-run directly
     against the database confirms all 7 KRMA-college students (5 test +
     2 sample) still resolve correctly under `college_id = 1` - the rename
     only changed the `name` column, not any id, so nothing keyed by
     `college_id` was affected. `GET /api/colleges` confirmed returning
     `KRMA CENTRAL`. Both TypeScript checks and the production frontend
     build passed; backend restarted.
  3. Added bulleted and numbered lists to the composer toolbar
     (`insertUnorderedList`/`insertOrderedList` via `execCommand`,
     matching the existing Bold/Italic/Underline pattern). `ul`/`ol`/`li`
     added to `sanitizeReplyHtml.ts`'s allowlist. `htmlToPlainText` was
     rewritten from a flat sequence of regex replacements into a small
     stateful walk with a list stack, since correct `<ol>` numbering
     needs a counter that resets per list and can't be expressed as a
     single blanket regex replace; it renders bulleted items as `- ` and
     numbered items as `1. `, `2. `, etc. Two real bugs in the first
     version of this logic were caught by the test suite itself (not
     assumed correct): a list ending right before a new `<div>` produced
     a spurious blank line, and a list starting right after other block
     content produced no line break at all - fixed by having list-open
     tags emit their own newline and collapsing any resulting
     doubled-up blank lines at the end, rather than special-casing every
     tag-transition pair individually.
     Verified: 19 sanitizer/plain-text scenarios (the full existing suite
     plus new list cases, including two independent `<ol>` lists in the
     same message not sharing a counter) all passed, plus one real
     end-to-end reply sent through the actual `sendReply` pipeline
     containing both a bulleted and a numbered list - confirmed correct
     HTML storage, a malicious `onclick` attribute stripped, and a
     naturally-readable plain-text fallback - with the test message's
     state cleanly reset afterward. Both TypeScript checks and the
     production frontend build passed; backend restarted.

  **Follow-up 2026-09-21 (raised by user before a real 1200-student KRMA
  import):** found and fixed a real bug rather than telling the user to
  work around it. `express.json()`'s default 100kb body limit meant a
  large CSV paste could get rejected with a 413 before ever reaching
  auth or the import logic - confirmed empirically both ways: a
  realistic 1200-row CSV (varied names/emails) measured at 79.5KB, right
  at that boundary, and a 150KB test body was confirmed to 413 under the
  old limit. Raised the limit to 10mb in `server.ts` (comfortably covers
  the full ~1600-student roster with room to grow) and confirmed the
  same 150KB body now correctly reaches the auth layer (401, not 413).
  Separately performance-tested `importStudents` directly with a
  synthetic 1200-row batch: a clean import completed in 1.6s
  (~1.4ms/row), and re-importing the identical batch (exercising the
  all-skip "already imported" path) took 157ms - no chunking into
  batches of 100 is needed on performance grounds; the only real
  constraint was the body-size bug, now fixed. Test rows cleaned up
  afterward. Backend restarted, TypeScript check passed.

**Post-demo customer feedback 2026-09-21 (three changes, completed same
day):**
1. **College name reverted: KRMA CENTRAL -> KSMA CENTRAL.** The customer
   confirmed after the demo that the original name was correct after all.
   New migration `007_rename_krma_back_to_ksma.sql` (the earlier
   `006_rename_ksma_to_krma.sql` was left as historical record, matching
   the established convention of never editing an applied migration) -
   same scope as before, inverted: `colleges.name`, the `students.college`
   text column (now correctly covering all 1270 KSMA students, including
   the 1263 real ones imported today under the "KRMA" name), and the
   "KRMA" label in the 5 test students' `name`/`last_name` fields.
   `schema.sql` and `branding.ts` updated to match. Mailbox addresses were
   never touched by either rename. Verified via `GET /api/colleges` and a
   direct query confirming all 1270 KSMA-college students now consistently
   say "KSMA CENTRAL".
2. **"Replied" tab relabeled to "Closed".** Deliberately a display-only
   change - `messages.replied`, the `StatusFilter` type, and the API's
   `status` parameter values all keep the internal name "replied" to avoid
   a much larger, riskier rename across the backend for something purely
   cosmetic to the user. `Console.tsx` gained a `TAB_LABELS` map instead of
   the previous auto-capitalized tab name; `MessageList.tsx`'s badge text
   updated to match. This is a deliberate reversal of the earlier decision
   in Step 12 ("retain Pending/Replied... rather than the earlier proposed
   Handled rename") - noted here since it directly contradicts prior
   documented guidance, now superseded by this explicit customer request.
3. **Universal "Close" button, no restrictions.** The existing "Mark as
   handled" button was narrowly gated (only appeared for an automated
   sender with a real link, and required the operator open that link
   first) - the customer's actual usage is expected to be ~90% "just
   received a code, nothing to reply to," so the gate was removed
   entirely per their explicit direction ("A close button broad, not
   narrow"). The button (renamed "Close") is now offered unconditionally
   whenever a thread has a pending message, for any sender, with or
   without a link. Implementation reused the existing backend
   `markHandled`/`handled_without_reply` mechanism unchanged - only the
   frontend gating (`canMarkHandled`, `linkNotYetClicked`, the
   click-tracking state, and the "open the link first" hint) was removed,
   along with the now-unused `containsLink`/`isAutomatedSender` exports
   from `linkify.ts`. Because it reuses the same mechanism, the existing
   timing-based reopen-on-new-message logic (`latestResolvedAt`/
   `stillPending` in `thread.ts`) applies automatically with no additional
   code - confirmed by test rather than assumed: closed an ordinary
   pending message (human sender, no link - a case the old gate would
   have blocked entirely) via `markHandled` directly, confirmed it moved
   from pending to closed, then inserted a synthetic follow-up message and
   confirmed the thread correctly reopened in pending. Message state was
   reset afterward; no test data left behind.
   Verified: frontend TypeScript check and production build both passed.

**Second post-demo feedback round 2026-09-21 (two more changes, same
day):**
1. **Pending tab shows a live count** (`Pending (N)`). Kept independent of
   whichever tab is actually open: `Console.tsx` added a `pendingCount`
   state and `loadPendingCount()`, which calls the existing
   `/api/threads?status=pending` endpoint with `limit=1` purely to read
   `.total` (no new backend endpoint needed - the existing thread-summary
   computation is the same cost regardless of how many rows are returned).
   Refreshed at every point `loadMessages` already refreshes (mount/tab
   change, the SSE update handler, after a reply/close, after a student
   import). "Closed" intentionally has no count - the customer's own
   framing was specifically that Pending is the primary workload signal.
   `TAB_LABELS` no longer needs to change for this - the count is appended
   only for the "pending" tab in the render, not baked into the label map.
2. **"Send another message" on fully-closed threads.** Previously, once a
   thread had no pending message left, `ThreadView` showed a flat "no
   pending messages" message with no way to compose anything further. The
   customer wanted a way to proactively follow up on an already-closed
   thread without it affecting status - reopening should only happen from
   a genuine new external reply, never from the operator's own follow-up
   send. This needed a real second code path, not just a UI toggle: the
   existing reply flow atomically *claims* the specific pending message
   before sending (`UPDATE messages SET replied = TRUE WHERE ... replied =
   FALSE`) specifically to prevent duplicate sends - that claim
   necessarily fails once a message is already resolved, by design.
   `reply.ts` was refactored to extract the shared SMTP-send-plus-record
   logic (`composeAndSend`) out of `sendReply`, then a new `sendFollowUp`
   calls that same shared logic with **no claim/unclaim at all** - it
   never touches `messages.replied`, so it structurally cannot resolve or
   reopen anything itself. New route `POST /api/messages/:id/follow-up`
   (same shape as `/reply` - sanitizes `bodyHtml` server-side, derives the
   plain-text fallback, accepts attachments - but does not check or
   require the target message to already be replied). Frontend:
   `ThreadView.tsx` computes `mostRecentIncoming` (for subject/recipient/
   threading headers only) whenever there's no `replyTarget`, and reuses
   the exact same rich-text composer, just relabeled ("Send another
   message" / "Sending as" / "Send message") and without the Close button
   (nothing to close). Verified with a real SMTP send against an
   already-`replied=true` message: confirmed the email actually sent,
   the `replies` row was recorded correctly, and - checked directly, not
   assumed - `messages.replied`/`replied_at` were completely unchanged
   before vs. after. Test reply row removed afterward.
   Verified: both TypeScript checks and the production frontend build
   passed; backend restarted.
3. **Central mailbox address removed from the header.** `Console.tsx`'s
   session bar no longer shows the raw central mailbox email
   (`central.ksma@myemailinfo.com`) - with `ACTIVE_CENTRAL_EMAIL`
   restricting login to exactly one mailbox, it never distinguished
   anything for the operator; the college name (already shown) is the
   piece of context that actually matters day to day. Removed the now-
   unused `email` prop from `Console` and its pass-through in `App.tsx`
   rather than leaving dead code. If genuine multi-operator support with
   different central mailboxes ever becomes real, this may be worth
   revisiting.
   Verified: frontend TypeScript check and production build both passed.
   No backend change needed.

- [ ] **Step 14 — AWS migration.** Not yet executed - discussion only so
  far, per the original scope (architecture, costs, security, data
  migration, backups, rollout agreed before provisioning anything).
  Currently mid-flight against a real deadline: customer demo'd tonight
  (2026-09-21) and wants a working AWS deployment by 10am tomorrow
  (2026-09-22).

  **Note:** a separate `command.md` file at the repo root tracks the
  live, granular AWS Console click-by-click progress (exact resource
  IDs, security group state, etc.) as a working handoff doc across
  sessions - this PROJECT.md entry covers the substantive decisions and
  status, not every console click.

  **Decisions made so far:**
  - Compute: one EC2 instance running both the Node/Express backend and
    the built frontend behind Nginx (reverse proxy + static file host +
    TLS termination) - matches this app's existing "intentionally
    simple" architecture, no separate services. Instance type ended up
    as **`t8i.small`** (2 vCPU, 2GB RAM), not the originally-discussed
    `t3.small` - chosen after checking the user's actual AWS free-tier
    credit balance ($100 remaining, on the newer post-July-2025
    credit-based free tier). `m7i-flex.large` (8GB RAM) was considered
    for the extra headroom but would burn the full $100 credit in ~6
    weeks of continuous runtime; `t8i.small` costs ~$54 for the
    project's full ~3-month lifetime, comfortably inside budget, and
    offers better CPU/network/EBS performance than `t3.small` at a
    similar price point.
  - Database: Postgres on the same EC2 instance (not RDS) - the user's
    explicit choice, prioritizing zero extra cost over RDS's managed
    automated backups. Recommended (not yet set up) mitigation: a cron'd
    `pg_dump` to S3 for a lightweight backup, given this holds real
    student data.
  - TLS: Certbot (Let's Encrypt) directly on the EC2 instance, not an
    ACM-issued cert - ACM certs only attach to AWS-integrated services
    (ALB/CloudFront), which would mean adding a load balancer (~$16-20/mo
    extra) purely for free-vs-managed cert tradeoff. Certbot is free and
    matches the same cost-conscious choice as the database. Needs a small
    recurring cron job for renewal (Let's Encrypt certs expire ~90 days).
  - **Domain: `myemailinfo.com`**, registered today via GoDaddy (the same
    domain student mailboxes already use, MX/SPF/DKIM/DMARC managed
    through Migadu separately from this app). Plan is a subdomain (e.g.
    `app.myemailinfo.com`) with an A record added in GoDaddy's DNS panel
    pointing at the EC2 instance's IP once it exists.
  - Secrets: same `.env`-file approach as local dev, placed on the EC2
    instance with tight file permissions - no Secrets Manager at this
    scale.
  - Attachments: currently local disk (`backend/uploads/`) - not yet
    decided whether that's acceptable on EC2 (attachments lost if the
    instance is ever replaced) or should move to S3. Flagged, not
    resolved.

  **Status: DEPLOYED. `https://app.myemailinfo.com` is live in
  production**, deployed entirely through the AWS Console (no AWS
  credentials were ever configured in this working environment) -
  `command.md` has the full click-by-click history if needed.

  - EC2 instance running: `i-0c104f1bad8f6009b` (`student-mail-app`),
    Ubuntu 26.04, 8GB gp3 unencrypted, no SSH key pair (access via
    browser-based EC2 Instance Connect instead; since then plain
    `ssh ubuntu@52.86.63.127` also works from the dev machine, which is
    how logs are read now). Logged into AWS via
    the root account rather than a dedicated IAM user, given the
    deadline - flagged as worth fixing later, not urgent.
  - Elastic IP `52.86.63.127`, GoDaddy DNS A record
    (`app.myemailinfo.com` → `52.86.63.127`), security group with
    SSH/HTTP/HTTPS all open to Anywhere-IPv4 permanently (including
    SSH - the EC2-Instance-Connect-specific prefix list couldn't
    coexist with the CIDR rule in the console UI, and the practical
    risk is low with no key pair/password auth to attack). Settled,
    not to be revisited.
  - Node.js, PostgreSQL, Nginx installed; code deployed via `git clone`
    (private repo, PAT-based auth, credential helper configured so
    future `git pull`s don't re-prompt).
  - Database migrated via one-time `pg_dump`/`pg_restore` (not an
    ongoing sync - AWS is now the sole source of truth). Had to set
    Postgres's local host connections to `trust` auth in `pg_hba.conf`
    to mirror local dev's passwordless setup.
  - `.env` configured on the instance with real credentials plus
    `FRONTEND_ORIGIN=https://app.myemailinfo.com` and
    `NODE_ENV=production`. Session cookie's `secure` flag changed from
    hardcoded `false` to `process.env.NODE_ENV === "production"`
    (`backend/src/server.ts`) so local dev still works over plain HTTP.
  - Nginx reverse-proxies `/api/` to the backend (port 3001, with
    `proxy_buffering off` for the `/api/events` SSE endpoint) and
    serves the built frontend as static files with SPA fallback.
    Certbot issued and auto-deployed a Let's Encrypt cert; auto-renewal
    scheduled.
  - Backend runs as a systemd service (`student-mail.service`).
  - Local dev backend stopped - clean cutover done, no risk of two
    processes racing on the IMAP UID watermark.
  - **Found and fixed during first production testing (not AWS-specific
    bugs, just first time this code path got real end-to-end exercise):**
    - Frontend's `API_BASE` was hardcoded to `http://localhost:3001` -
      broke entirely in production. Fixed by making it a Vite env var
      (`VITE_API_BASE`, empty in `frontend/.env.production` so it
      resolves to relative `/api/...` paths through the Nginx proxy).
    - `/home/ubuntu` directory permissions blocked Nginx's `www-data`
      user from traversing into `frontend/dist` (500 errors) - fixed
      with `chmod o+x` on the directory chain.
    - Closed tab was sorting threads by newest incoming message
      instead of by when they were actually closed/replied to - fixed
      in `backend/src/thread.ts`'s `fetchThreadSummaries`: pending
      threads still sort by newest incoming message, closed threads
      now sort by `resolvedAt` (last reply/follow-up `sent_at`, or the
      Close button's timestamp).
  - End-to-end tested on the real domain: login, college picker,
    student list, rich-text reply, Close button, follow-up on a closed
    thread, pending count badge, Closed tab ordering - all confirmed
    working.
  - Not done, optional hardening for later: auto-deploy-on-push to
    main (user's stated intent, not built yet), S3 for attachments
    (currently local disk, lost if the instance is replaced), IAM user
    instead of root login, EBS encryption, automated DB backups.

- [x] **Step 15 — Search on the Pending/Closed console.** Customer
  request: search Pending/Closed by first name, last name, or email,
  opening matches "elastic way" (partial, not just exact match).

  Design decisions, settled before touching code:
  - One search box, shared across both tabs - the same typed term
    stays applied when switching Pending/Closed, so a user unsure
    which tab a thread landed in doesn't have to retype anything.
    Confirmed via a UI mockup before building.
  - No new table/results view - filtered results render through the
    existing `MessageList` row styling; only which rows show changes.
    (An earlier table-view design was dropped as too big a UI change
    for what the customer actually asked for.)
  - Tab counts: with no search, only Pending shows a live count
    (unchanged). While searching, both tabs show their match count,
    since the user may not know which tab a thread is in.

  Backend (`backend/src/thread.ts`):
  - `fetchThreadSummaries` takes an optional `search` param. When
    present, it resolves matching students first (`ILIKE` on a
    trigram-indexed, coalesced `first_name || last_name || email ||
    ...` column - reusing the same pattern and index as the admin
    roster's `searchAdminStudents`), then narrows the message fetch to
    just those students' emails (`fetchMessagesForStudentEmailsScoped`,
    still filtered by the message's own `central_email`, same as the
    no-search path) instead of scanning every message for the college.
    Thread grouping and pending/resolved computation are untouched.
  - New index: `idx_messages_student_email` on `messages(student_email)`
    - needed once search started looking up messages by student email
      at scale (no such index existed before). Additive only, no
      existing data touched; safe to apply with plain `CREATE INDEX`
      given downtime was approved for this deploy (no need for
      `CONCURRENTLY`).
  - Fixed during review: the search-candidate query no longer filters
    students by `students.central_email` (only by `college_id`) -
    that column is "who currently manages this student's mail today",
    not a fixed owner of their past messages, so filtering by it could
    have hidden a student whose messages still belong to this
    operator. The real `central_email` enforcement is on the message
    fetch itself, same place the no-search path enforces it.
  - Fixed during review: the raw search term is now escaped
    (`escapeLikePattern`) before being used in `ILIKE '%term%'`, so a
    literal `_` or `%` in a search (e.g. part of an admission ID) is
    matched literally instead of as a SQL wildcard.

  Route (`backend/src/server.ts`): `GET /api/threads` reads an
  optional `search` query param, trims it, passes it through.

  Frontend (`frontend/src/Console.tsx`, `api.ts`, `App.css`): a
  debounced (300ms) search input above the tabs, matching the existing
  `admin-search` input styling from `ManageStudents.tsx`, with a clear
  ("×") button. Also fixed in passing: the browser tab showed the
  unedited Vite scaffold title ("frontend") and default favicon -
  `frontend/index.html` now uses "Student Mail Console" and the ISM
  Edutech logo already used in the app header.

  Verified locally against a fully isolated dev setup - **not** tested
  against production data or credentials:
  - A standalone local Postgres instance (separate data directory,
    port 5433, owned by the OS user directly - no `sudo`, no system
    Postgres service involved) with `schema.sql` applied and fake
    seed data (`backend/scripts/dev-seed.sql`, not wired into any
    startup path or CI - only runs if invoked manually).
  - A separate `backend/.env.local` (git-ignored, never committed)
    pointing at that dev DB and using the user's own GoDaddy mailbox
    (`pankaj@system-design.in`) for local login, kept deliberately
    distinct from prod's `ACTIVE_CENTRAL_EMAIL`
    (`central.ksma@myemailinfo.com`) and prod's DB port (5432) so a
    local run can never reach production. Confirmed via diff/mtime
    that prod's own `backend/.env` was never touched.
  - Confirmed end-to-end in the browser: partial/mid-word matching,
    email matching, the shared-search-across-tabs scenario (search
    "gupta" on Pending, no match there, switch to Closed with the same
    term still applied, match found), and the clear button reverting
    both tabs to their normal unfiltered state.
  - Confirmed via a direct call to `fetchThreadSummaries` against the
    seeded data (bypassing login, which needs a real mailbox password
    this session never handles) that both post-review fixes behave
    correctly, including a literal-underscore admission ID matching
    exactly and not over-matching.
  - `schema.sql` diff reviewed line-by-line to confirm the only change
    is the new additive index - no `ALTER TABLE`, no column or data
    changes, nothing that touches existing rows.

  Deployment note: the new index needs to be applied to production
  manually as part of the deploy (`schema.sql` is a reference file,
  not auto-applied) - a plain `CREATE INDEX idx_messages_student_email
  ON messages (student_email);`, acceptable with the downtime already
  approved for this change.

- [ ] **Step 16 — Automatic per-student mailbox check on search.**
  (Checkbox left open until the user confirms the live UI test on AWS.)
  Why: a 2026-09-25 diagnosis of shakil.shahriyar@myemailinfo.com showed
  Migadu accepting inbound mail then holding it 45 min – 5 h 44 m before
  storing it (e.g. an Edugate code from confirm@edu.gov.kg), and the
  central sync can only attribute mail by the To header (BCC'd /
  mailing-list mail is skipped). Staff typically fill a college form for a
  student and wait for an emailed code; when it doesn't show up they need
  a way to look in that student's own mailbox directly.

  Design decisions, settled with the user before touching code (mockup
  approved):
  - No background sweep of student mailboxes - with ~2300 students that is
    far too many Migadu logins. The check is on demand only.
  - Trigger: the existing Step 15 search box. When the search matches at
    most 3 students (~1.5 s after typing stops), each of their INBOXes is
    checked automatically, in parallel. 4+ matches → no check, just a grey
    hint "To check a student's mailbox, type their email." (Originally
    "exactly one student"; changed after the first AWS test - "shakil"
    also matched AREEBA SHAKIL SHAIKH, who has no messages, so the list
    looked like one student but nothing ran. Staff are told to search by
    email: full names repeat in the roster, e.g. two AFNAN SHAKILAHMED
    KHATUDA with different emails.)
  - UI: one status line under the search box - "Checking <name>'s
    mailbox…" (or "Checking N mailboxes…"), then a green "Mailbox(es)
    checked just now: N missing emails added" / "nothing missing…" with a
    **Check again** button that re-checks all of them. No other UI change.
    Staff only. If some of the students' checks fail they're left out of
    the total; if all fail the line disappears.
  - Failures show NOTHING in the UI (the status line just disappears) -
    operators are clerk-level and can't act on errors. They are logged
    instead: `[check-mail] FAILED student=… id=… operator=… reason=auth|
    timeout|network|error (detail)`. Successes log `[check-mail] OK …
    checked=N added=N`, each recovered message logs `[check-mail]
    RECOVERED …`. Find failures with
    `sudo journalctl -u student-mail --since "7 days ago" | grep "check-mail] FAILED"`.
    Passwords are never logged.
  - INBOX only (Migadu spam filtering is off, Junk stays empty), read-only
    (IMAP EXAMINE - nothing gets marked read), last 7 days by server
    arrival date (so hours-late Migadu deliveries are included).
  - 2-minute per-student cooldown for automatic checks (returns the last
    result without logging in again); Check again bypasses it. Concurrent
    checks of the same student share one IMAP session. 45 s timeout.

  Backend:
  - `sync.ts`: the INSERT moved into exported `insertMessageForStudent()`,
    shared by both paths; central sync behavior unchanged. Both key on
    `(message_id, student_email)` with `ON CONFLICT DO NOTHING`, so a
    message arriving via central AND via the direct check is stored once.
    No schema change / migration.
  - New `checkStudentMail.ts`: fetches envelope Message-IDs first, compares
    with the DB, downloads full source only for missing ones; the mailbox
    owner is the student, so no To-header matching.
  - `thread.ts`: `findSearchMatches(search, collegeId, max)` - same search
    predicate/index as the console search, `LIMIT max+1`, returns
    `{students, tooMany}`.
  - `server.ts`: `GET /api/check-mail/match?search=` (→ `{students,
    tooMany}`, max 3, only the operator's own students) and
    `POST /api/check-mail/:studentId` (`{force}`), both behind
    requireAuth + requireCollege, restricted to non-deleted students of the
    session's college whose `central_email` is the operator's (recovered
    rows are stored under that central mailbox). Broadcasts an SSE update
    when something was added.
  - Uses `IMAP_HOST` (Migadu in prod) and the student's `smtp_password`.

  Frontend: `api.ts` (`fetchMailCheckMatches`, `checkStudentMail`),
  `Console.tsx` (status line, stale-result guard per search), `App.css`
  (`.mail-check*`).

  Verified locally (dev Postgres on 5433, test student Shakil added to the
  dev DB only, check run against the real Migadu inbox via a scratch
  script): search "shakil" → one match, "pilot" → none (several); first
  check 12 checked / 12 added (incl. the delayed Edugate mail and the
  empty-subject mail); automatic repeat inside cooldown → cached, no login;
  forced re-check 12 / 0 added, all 12 envelope Message-IDs matched stored
  rows exactly (nothing re-downloaded); UNSEEN set in the mailbox identical
  before/after; wrong password → `reason=auth` log line, UI result
  "failed". Frontend + backend `tsc` clean, oxlint no new warnings.
  Browser UI test not possible locally (local login is GoDaddy, students
  are on Migadu, one `IMAP_HOST`), so per the user it is tested on AWS
  after deploy (prod DB backed up first to
  `~/backups/pre-step16-20260925T184313Z.dump`); rollback = `git revert`.
  First AWS test: searching `shakil.shahriyar` worked end to end; plain
  `shakil` did nothing (2 matches, see Trigger) → up-to-3 change. Up-to-3
  matching verified against the dev DB: "shakil" → 1, "gupta" → 3,
  "pilot" → tooMany (6), no match → none.

  Follow-up - automatic reload onto new deploys (`frontend/src/
  versionCheck.ts`): the second AWS test "didn't work" only because the
  operator's tab still ran the 18:46 bundle against the 18:56 backend (old
  JS read the new `/match` response as "no student"; nginx log showed the
  match calls but no POSTs). Now every console checks once a minute and on
  tab focus whether `index.html` references a different
  `/assets/index-*.js` than the one it loaded (1 min agreed with the user:
  ~320-byte static fetch, negligible; longer only widens the stale
  window). If so it reloads itself - but never while an email is open
  (might be typing a reply); it waits until the operator leaves it. The
  search box text survives the reload (sessionStorage). No-op under
  `npm run dev`. Tabs opened before this deploy still need one manual
  reload; every deploy after that is picked up automatically.

  Follow-up - code / login box on opened threads (`frontend/src/
  keyInfo.ts`, `KeyInfoBox.tsx`, `ThreadView.tsx`): staff open these
  threads for a verification code or login credentials, so when the
  thread's newest matching email is from a sender whose exact template is
  known, a box above the thread shows the value(s) with Copy buttons.
  Decisions agreed with the user (mockup approved):
  - Only fully verified templates, never guessing - "each college can
    have its own style, so only do it when we are fully sure". So far:
    Edugate (`confirm@edu.gov.kg`), English + Russian, code email ("Your
    verification code:" / "Ваш код подтверждения:" → exactly 6 digits →
    exact "valid for N minutes" sentence) and login email ("Login
    (Email):" / "Логин (Email):" → email → "Password:" / "Пароль:" →
    password). Login must equal the thread's student. Any deviation →
    no box, thread looks as before. New senders are added one template at
    a time after checking real emails.
  - Box is always English (staff only read English); only the values come
    from the email. No "email is in Russian" note (user: not needed).
  - Only the newest matching email in the thread; older codes are
    expired anyway.
  - Code shows "received X min ago"; once older than the validity the
    email itself states (30 min today), the code is struck through with an
    amber "probably expired - ask for a new code" warning (Migadu delays
    can make the newest code in the console an expired one).
  - Verified before building against every Edugate email in production
    (read-only; codes/passwords masked in all output, local copies
    shredded): 579/579 matched - 292 code (all 6 digits, all 30 min), 287
    login (all login == thread student), 0 ambiguous. The built
    `keyInfo.ts` itself was then run against all production messages:
    292 code + 287 login boxes, 93/93 other-sender emails no box, a
    two-code thread picks the newest, a 5-digit code is rejected.
  - Added later: **Edugate document rejections** (`notify@edu.gov.kg`,
    subject "Абитуриент Колледж"). A read-only scan of production found
    38 such emails (22–25 Sep), all "❌ Document rejected", identical
    layout (Russian half, dashed separator, English half), every
    reviewer note present in English. The box uses only the English half
    and is **red** (a warning - someone has to act): "❌ Document
    rejected", received time, Document (wrapped lines joined), the
    reviewer's note in bold, Reviewed date. The note is kept whole and
    labelled **"Action needed"** if it contains a "Please …" / "Upload …"
    sentence, otherwise **"Reason"** (user chose this over splitting
    sentences - no guessing). Notes with no letters (4 reviewers typed
    just "1") → the note line is left out, no placeholder text (user:
    don't write "no reason given"). Edugate's WhatsApp sentence (always
    +996 755 979 827, only in 25 Sep emails) is removed from the note
    wherever it appears - the user chose to leave it out of the box; it
    stays in the email. Verified with the real `keyInfo.ts` on every
    production email: 38/38 rejection boxes (28 "Action needed", 6 "Reason",
    4 with the note hidden), no WhatsApp or Cyrillic in
    any box, code 292 / login 287 unchanged, 86 other-sender emails no
    box.

  Follow-up - new-mail chime (`frontend/src/chime.ts`): a soft two-note
  Web Audio chime when new incoming mail arrives for the college the
  console is showing. The user chose chime only (no desktop
  notifications - those need a browser permission click, and staff "are
  not using" even the Close button) and no on/off setting. Backend:
  `syncInbox` now returns `insertedStudentEmails`; `mailboxSync.ts` looks
  up their `college_id`s and adds `collegeIds` to the `new-mail` SSE
  event (lookup failure → no chime, never a failed sync). Frontend:
  `subscribeToUpdates` passes the event data; `Console.tsx` chimes only
  for `reason === "new-mail"` including its college - replies, closes and
  mailbox-check recoveries stay silent. One chime per burst, at most every
  10 s. Browser rule: sound only after the first click/keypress on the
  page since it loaded (so silent right after an automatic reload until
  the operator clicks anything).

### Approved test roster (passwords intentionally omitted)

Final import needs the Password column from Step 8, supplied privately.
These Application Numbers replace the earlier shared `TEST` values.

| Student Name | College | Application No | Email |
|---|---|---|---|
| Test Student 1 KRMA | KRMA CENTRAL | 97299038 | test.ksma1@myemailinfo.com |
| Test Student 2 KRMA | KRMA CENTRAL | 88067600 | test.ksma2@myemailinfo.com |
| Test Student 3 KRMA | KRMA CENTRAL | 58323203 | test.ksma3@myemailinfo.com |
| Test Student 4 KRMA | KRMA CENTRAL | 10610719 | test.ksma4@myemailinfo.com |
| Test Student 5 KRMA | KRMA CENTRAL | 60253661 | test.ksma5@myemailinfo.com |
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
  (`insertMessageForStudent()` is shared with `checkStudentMail.ts`)
- `checkStudentMail.ts` - Step 16 on-demand direct check of one student's
  own INBOX (read-only, 7 days), adds whatever the console is missing
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
- `keyInfo.ts` / `KeyInfoBox.tsx` - exact per-sender templates (Edugate)
  that pull a code or login credentials out of an opened thread, and the
  box that shows them above it
- `chime.ts` - new-mail chime (Web Audio, one per burst, own college only)
- `versionCheck.ts` - detects a newer deployed build (1 min + on focus);
  `Console.tsx` reloads onto it when no email is open

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
- **Risk analysis for every change.** Each step's section in this file carries a risk analysis
  table (columns: Area, Risk, Why) and an overall rating, written before check-in and updated if
  the deploy teaches anything new. Cover at least: data and database, security and access, wrong
  results or behavior, performance, effect on open sessions and users, deploy and rollback, and
  any residual gap. Standing instruction from the user, 2026-10-01 (applies from Step 35 on).
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
- Commit and push (`git push origin main`) now work from the dev machine, but only when the
  user says to (see the rules above and `AGENTS.md`). The older note that the sandbox had no
  GitHub credentials is out of date.

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

## Step 18 — Edugate registration status (phases 1 and 2)

Goal (user, 2026-09-25): know per student where they are in Edugate - no
code yet / code sent / registered - and later (phase 2) stop registered
students' code emails cluttering Pending. Split in two deploys on purpose:
**phase 1 records and shows the status but changes nothing in Pending /
Closed**, so any mistake shows up as a wrong label, never as emails
silently moving; phase 2 changes the lists once statuses are confirmed.

Phase 1 (this step):
- **Shared templates** `shared/edugate.ts` (repo root, with its own
  `package.json` `"type": "module"`): the verified Edugate rules moved out
  of `frontend/src/keyInfo.ts` into one file used by both the frontend
  (the box) and the backend (status), so they can't drift apart.
  `frontend/vite.config.ts` allows the dev server to read `..`.
- **Migration 010** (all nullable, no defaults, nothing existing changes):
  `messages.sent_at` (sender's `Date:` header - ordering uses this, not
  arrival, because Migadu can hold mail for hours), `messages.edugate_kind`
  (`code` | `login` | `rejected` | NULL), `students.registration_status`
  (NULL | `REGISTRATION_PENDING` | `REGISTERED`), `students.code_sent_at`,
  `students.registered_at` (latest of each kind, by sent time).
- **New emails** (`insertMessageForStudent`, so central sync, mailbox
  check and a future sweep alike): store `sent_at` + `edugate_kind`, then
  `registrationStatus.ts`'s `applyRegistrationEvent`. Rules: a code →
  REGISTRATION_PENDING unless already REGISTERED; a login → REGISTERED;
  **REGISTERED never goes back** (a code after registration - the student
  asked for another one - only moves `code_sent_at` forward); times only
  move forward (`GREATEST`), so an older email arriving late changes
  nothing. A status-update failure is logged, never fails the insert.
- **Unknown layouts**: any email from an Edugate sender that matches no
  verified template logs `[edugate] UNKNOWN LAYOUT from=… student=…
  subject=…` - e.g. a password-reset email (none seen yet). No box, no
  status change; staff see it as a normal email.
- **Manage students**: new "Edugate status" column - green "Registered ·
  date" (plus an amber "new code sent …" line when the latest code is
  newer than the registration), amber "Code sent · date", or "—"; and a
  checkbox filter "Show only: code sent, not registered"
  (`GET /api/admin/students?registration=pending`).
- **Backfill** `backend/scripts/backfill-edugate-status.ts`: dry run by
  default (read + report only; works even before migration 010), writes
  only with `--apply`, in one transaction, only the new columns. Reads the
  central mailbox's `Date:` headers read-only over IMAP (matched by
  Message-ID), classifies every stored email, then recomputes every
  student's status (`RECOMPUTE_ALL_SQL`, safe to re-run).

Verified before deploy:
- Dev DB: migration 010 applied; backfill dry run + apply (1 dev student
  with a code email → REGISTRATION_PENDING, rest NULL). End-to-end through
  the real insert path with synthetic emails: code → PENDING; login →
  REGISTERED; an older code arriving late → no change; a new code after
  registration → still REGISTERED, `code_sent_at` moved forward; unknown
  Edugate layout → logged, no change; non-Edugate email with a code in it
  → ignored. Test rows removed.
- Production **dry run** (read-only, via an SSH tunnel, before migration
  010): 703 messages, sent time found for 657 (668 Date headers in
  central; the rest fall back to arrival time); edugate_kind: 292 code,
  287 login, 38 rejected, 86 other; **0** Edugate emails matching no
  template; resulting status **287 REGISTERED, 3 REGISTRATION_PENDING, 0
  registered-with-a-newer-code**, everyone else NULL.
- DB snapshots before any change: prod `~/backups/pre-010-20260925T213443Z.dump`,
  dev `~/.local/share/student-mail-devpg-backups/dev-pre-010-….dump`.

Deploy order: backup → `git pull` → apply `010_registration_status.sql`
→ backfill dry run → `--apply` → restart backend → rebuild frontend.

Phase 2 (built after the user confirmed phase 1's statuses in Manage
students):
- **No more Pending/Closed tabs** (user chose option B). Production data
  showed why: 703 emails, 617 (88%) automated Edugate mail nobody replies
  to; in a week staff sent 24 replies and pressed Close 49 times. The
  console is now **one list, newest first**, each thread with one badge:
  green **REGISTERED** (registration email - copy login + password), red
  **REJECTED**, blue **CODE · N min** (amber **CODE · expired** after 30
  min), and for other mail **NEW** (unanswered) / **Replied**. The
  "Pending (N)" count is gone. `GET /api/threads?status=all`
  (`thread.ts` `threadBadge`); `pending`/`replied` still work.
- **Superseded codes** (`autoClosed` in `thread.ts`): a verification code
  whose student has a registration email **sent after it** (sent times,
  not arrival - Migadu delays) no longer counts as needing attention.
  Computed at read time - no message's replied/handled data is changed. A
  code sent after the latest registration stays live. Such threads get a
  grey **USED** badge and are **hidden from the main list but shown
  dimmed when searching** that student (user agreed: an email that can
  never be found looks like a bug; ~290 dead codes would swamp the list).
- **Close button removed** from the thread view (Reply stays for the rare
  non-Edugate email). The reply panel ignores superseded codes.
- **Outdated registration box** (amber): "⚠ A newer login was sent on …
  Use that one." (a later registration email exists, values struck
  through), or "⚠ A newer Edugate email arrived on … Check it before
  using this password." (a later Edugate email we don't recognise, e.g. a
  password reset). From `newer_login_at` / `newer_edugate_at` on thread
  items.
- List rows show the student's **name** (first + last from the roster,
  bold) with the email underneath; falls back to the email alone if no
  name is stored (`student_name` on thread summaries, one query per
  page). List column widened 380 → 460 → 540 px, then made proportional to the
  window (user): `--list-width: clamp(380px, 38vw, 720px)`, shared by the
  search box.
- Console header (user): ISM Edutech and college logos 32 → 64 px on the
  left, 48 px apart with a thin divider line centred between them (user:
  "still too close"), "Student Mail Console" + college name centred
  across the full width (3-column grid `1fr auto 1fr`), buttons on the
  right; under 1000 px the title drops below the logos.
- Login and college picker (user): ISM logo 40 → 88 px, centred at the top
  of the card, with the title and subtitle centred under it; login page
  uses the site typeface.
- **Visual refresh, part 1** (mockup approved, user: "all good go
  ahead"): English everywhere - recognised Edugate threads are titled
  "Verification code" / "Registration: login details" / "Document
  rejected: <document>" in the list and as the thread heading
  (`edugateTitle` in `shared/edugate.ts`, `title` on thread summaries);
  other emails keep their subject. A student line (name · email) under the
  heading. The original Edugate email is collapsed under "▸ Show original
  email" (the box already shows everything). Opening it shows the whole
  email at once - no second "Show full message" click (user). One date format everywhere
  ("25 Sep, 7:39 AM", `frontend/src/format.ts`); Edugate's "25.09.2026
  08:09" review time shown as "25 Sep 2026, 08:09" without timezone
  conversion. Verified on production data: 288 registration, 38 rejection
  and 2 code threads get English titles; the rest keep their subject.
- **Visual refresh, part 2**: IBM Plex Sans / Plex Mono (Google Fonts in
  `index.html`) for the whole site; one palette as tokens in a single
  "Visual refresh, part 2" layer at the end of `App.css` (overrides the
  older values); page background forced light (the Vite starter
  `index.css` switched it dark with the OS theme - the dark bands at the
  window edges); header + search + filters in a fixed white top area
  (`.console-top`) with the list and email panes filling the rest of the
  window and scrolling on their own (thin scrollbars); calmer badges (soft
  background + coloured dot, strong colour kept for the boxes); clearer
  selected row (blue left edge); codes/passwords in Plex Mono; a shimmer
  placeholder while the list loads; friendly per-filter empty messages
  ("No rejected documents. Nothing to re-upload." …). Under 900 px the
  panes stack and the page scrolls normally. Not screenshot-tested here
  (no browser in this environment) - checked by the user after deploy.
- **No reply box on automated emails** (user): threads whose email comes
  from an automated sender show a grey note ("Automated email from …:
  replies aren't read, so there's no reply box.") instead of the reply
  panel. Automated = both Edugate senders (confirm@ / notify@edu.gov.kg,
  ~9 in 10 emails; the emails say "do not reply") or a local part like
  noreply / no-reply / donotreply / notify / notification(s) /
  mailer-daemon / postmaster / bounce(s) on any domain
  (`frontend/src/automatedSender.ts`). Real people keep the reply box.
- Compact rows (user's idea, option a): subject · sender and a short
  time ("25 Sep, 6:03 PM") share one line (sender shortened with … before
  the time); the preview line is dropped for Edugate threads (always the
  same boilerplate) but kept for other emails, where the first words of a
  student's question help. Then (user) name and email on one line too:
  Edugate rows are 2 lines - "NAME email … BADGE" / "subject · sender …
  time"; the email is the part that gets shortened, never the name,
  badge or time.
- **Live code in the list** (user): a CODE badge shows the code itself
  while it's valid - "CODE 118134 · 12 min" - and just "CODE · expired"
  (no number) once older than the validity the email states (30 min), so
  nobody copies a stale code from the list; USED threads never show one.
  `code` / `code_valid_minutes` on thread summaries (shared templates);
  the list re-renders every 30 s so the number disappears on time. No
  Copy button in the row (opening the thread gives the box with Copy).
- **Filter buttons** under the search box (`FilterButtons.tsx`, mockup
  approved): All · Code received · Code expired · Registered · Rejected ·
  Other emails, each with a live count for the current search. One filter
  at a time; three ways back (user asked for a clear one): the "← All"
  button (outlined in blue whenever a filter is on), the ✕ on the pressed
  button, or pressing it again. Filters combine with search. Backend:
  `GET /api/threads?status=all&filter=code_live|code_expired|registered|
  rejected|other`, and `counts` on every list response (`thread.ts`
  `threadCategory`; code live vs expired by the validity the email states).
  USED codes belong to no filter (they only appear, dimmed, under All
  while searching). Verified on production data: per college the buttons
  add up to All (KSMA 238 = 0 + 2 + 192 + 29 + 15), each filter returns
  exactly its count, filter + search works. Search box widened to 540 px
  to match the list.
- **Edugate login inside the red rejection box** (user: "staff does it,
  students don't handle anything"): all 38 rejections in production came
  after the student registered (avg 7.4 h later, 23 students) - Edugate's
  order is code → registration → upload documents → review → rejection →
  re-upload. Staff re-upload on the Edugate portal with the student's
  login, so the red box now also shows **Edugate login + Password** (Copy
  buttons) from the student's **latest** registration email (same
  operator, same verified template), "from the registration email of …",
  and the amber "newer Edugate email" warning if an unrecognised later
  Edugate email exists; "No Edugate login found for this student." if none.
  `edugate_login` on rejection thread items (`fetchThread`). The "1"
  reasons (4 emails, one reviewer, 23.09 12:07-12:08) carry no meaning in
  either language - nothing more to show.
- **"Open Edugate ↗"** button in the login box and the red rejection box,
  opening `https://edugate.ilim.gov.kg/edugate/login` in a new tab
  (`EDUGATE_LOGIN_URL` in `shared/edugate.ts` - change it there if
  Edugate moves). The emails carry no link; the user confirmed the portal
  ("Цифровые ворота" = Digital Gate, on the ministry's ilim.gov.kg domain)
  by logging in with a student's credentials. Staff flow: Copy login →
  Open Edugate → paste → Copy password → paste → re-upload.
  An **expired** code box also gets **"Request a new code ↗"**, opening
  `https://edugate.ilim.gov.kg/edugate/register` (`EDUGATE_REGISTER_URL`,
  given by the user) in a new tab; a still-valid code has no button (staff
  are already on that page to type it in). An expired code has no Copy
  button (user) - it stays visible, struck through.
- Verified read-only against production (via SSH tunnel) before deploy:
  KSMA CENTRAL list 272 threads (192 REGISTERED, 29 REJECTED, 2 CODE, 49
  Replied), 193 superseded codes hidden; IHSM CENTRAL 107 shown / 91
  hidden; IHSM ELITE 11 / 5. umme.mandal: registration thread REGISTERED,
  code thread `auto_closed` → USED, hidden without search and shown when
  searching. Frontend + backend type-check, build clean.

## Step 19 — Fix: emails lost when Migadu returns them without content

Found while checking why mahek.khan showed "code sent, not registered":
her registration email (24 Sep 09:31:20) WAS in central's inbox (UID
429), but the sync logged `UID 429: no message source returned by IMAP
fetch, skipping` 3 s after it arrived - and still moved
`central_mailboxes.last_uid` past it, so it was never tried again. The
console missed it for 2 days (recovered with the mailbox check; she's now
REGISTERED). The same skip appeared **~40 times in 4 days** of logs: Migadu
briefly serves a just-arrived email without its content. Of 39 skipped
UIDs: 17 no longer in central (old setup / tests), 20 had been recovered
since by other paths (e.g. the search mailbox check), 2 were our own test
emails deleted on request - so no real email was still missing, but any
could have been.

Fix (`sync.ts` `syncInbox`): an email that comes back without content is
retried - the watermark stops just before the lowest such UID
(`newLastUid = min(maxUidSeen, retryFromUid - 1)`), and `triggerSync`
schedules a follow-up pass 5 s later (`retryPending`). Emails after it are
still stored immediately (no blocking); re-reading them is a no-op (ON
CONFLICT). After 5 failed attempts in a row (in-memory counter per
mailbox/UIDVALIDITY/UID) it logs `[sync] … GIVING UP uid=… after 5 tries`
and moves on, so one broken email can't block the rest. Retries log
`… no message source … (attempt n/5), will retry`. The `[migadu-delay]`
line is now logged only for emails actually stored on that pass (a retry
pass re-reads a few stored ones).

Verified with a simulated mail server (ImapFlow patched in a test, real
`syncInbox` against the dev DB): empty once → stored on the next pass;
never any content → 4 retries, give up on the 5th, later emails unaffected;
normal case unchanged. Also fixed `schema.sql`, which lacked
`central_mailboxes.last_uid` / `uid_validity` (migration 004) - the dev DB
was missing them too and now has them.

## Migadu delay logging (done, part of Step 17)

`backend/src/migaduDelay.ts`, called from `sync.ts` for every email the
central sync reads: compares Migadu's own Received headers - accepted
(`by mizuN.migadu.com with ESMTPS` inbound, or `by smtp.migadu.com with
ESMTPS` from our own mailboxes) vs stored (`by soraStorageN.migadu.com
with LMTP`) - and, if Migadu held the email longer than
`MIGADU_DELAY_WARN_MIN` (default 5), logs one line:

`[migadu-delay] held=64m queue=e158f4f432e3a08b accepted=… stored=…
mailbox=central.ksma@… from=confirm@edu.gov.kg student=… message=<…>`

Also stored on every new message row (migration
`009_migadu_hold.sql`): `messages.migadu_hold_seconds` (INTEGER) and
`messages.migadu_queue_id` (TEXT), both nullable - rows from before the
migration stay NULL (no backfill, by the user's decision: the 25 Sep
incident only touched 2 Edugate emails, and a one-off read-only scan of
central's 671 emails already captured the history - 24 holds > 5 min,
all 25 Sep 11:29–17:42 UTC, none on 22–24 or 26 Sep). Filled by both the
central sync (central's copy) and the mailbox check (the student's own
copy - Migadu holds each recipient's copy separately). Unreadable
headers → NULL, never a failed insert. Example query:
`SELECT received_at, migadu_hold_seconds/60 AS min, migadu_queue_id,
sender_email FROM messages WHERE migadu_hold_seconds > 300 ORDER BY
received_at DESC;` **Deploy order: apply 009 before starting the new
code** (the INSERT names the new columns). No UI change, never throws. Find incidents with
`sudo journalctl -u student-mail --since "7 days ago" | grep migadu-delay`
and send the queue IDs + times to Migadu support. Verified against real
headers: central's copy of Shakil's Edugate email → 64 m, Shakil's copy
→ 344 m, Tahir's Gmail → 272 m, a fast delivery test → 0 m (no line),
non-email input → no result.

## Step 30 — Students dialog: all colleges, read-only; status link; year on import

**Status: DEPLOYED 2026-09-29 18:11 UTC** (`0e27561`), no consoles in use
(user asleep). Before it: fresh dump `student_mail-20260929T181106Z` on the
server, in S3 (encrypted, via `backup-db.sh`) and locally in `~/backups`.
On the server: `git pull --ff-only`, migration 013 applied (2280 empty years
set to 2026, index rebuilt, one transaction), `npm run build` in
`frontend/`, `student-mail.service` restarted - API up, central IDLE watcher
reconnected, syncs normal, 0 errors in the log. Validated on prod with the
real queries: roster 2280 = 1269 KSMA CENTRAL + 582 IHSM CENTRAL + 429 IHSM
ELITE; each college filter returns only its college; Tanisha search shows
tanisha.gawande (registered) and tanisha.rahaman (code_expired), both 2026;
"2026" matches nobody; 0 active students with an empty year; the console's
college-scoped counts and search are unchanged; delete route now 404, roster
route 401 without login, `/status` and the app serve 200, the new bundle has
"System status" and no delete UI. The browser click-
through (layout, phone width) is still the user's. Why (user, 2026-09-29): staff had to search whether a student
has an email at all (Tanisha Rahaman's case) and the roster only showed the
selected college. The user also asked for a link to the status page and a
year on every student. Decisions made with the user in chat:

- **Roster is read-only and shows every college** (still limited to the
  operator's central mailbox, so the 8 old rows of the retired
  `pankaj@system-design.in` mailbox stay hidden). This deliberately reverses
  the per-college roster scoping of Step 6; staff share one login and could
  already pick any college, so no permission boundary is crossed. The
  console's Pending/Replied threads and their search stay college-scoped.
  `GET /api/admin/students?college=<id>` narrows to one college.
- **Delete, restore and the Deleted tab are gone** (UI, API and backend
  functions: `softDeleteStudents`, `restoreStudent`,
  `pendingCountsForStudents`, and their three routes). Reason: nobody used
  them and deleting is the risky part; removing a student is now done by
  hand (soft delete = set `deleted_at`, after a backup). Re-importing an
  unchanged deleted student still restores it.
- **Dialog**: renamed from "Manage students": the header button is
  **Find/Add Students**, the dialog title **Students**, and the tabs
  "Search students" and "Add students" (first named "Find students", renamed
  the same evening at the user's request). A College
  button row (All default, then one per college, with counts for the
  current search) sits above the Status row, plus a **College** column.
  Counts: college buttons ignore the pressed college/status; status counts
  follow the pressed college. `collegeCounts` comes with the first page.
- **System status** link next to the Students button, opens `/status` in a
  new tab (read-only page behind the same login).
- **"Other emails"** filter button in the console hides when its count is 0
  and it is not the pressed filter.
- **Year**: migration `013_year_and_search.sql` sets `year_enrolled = 2026`
  on every active student with an empty year (the import format lost its
  year in Step 3/4; it was never a deliberate blank). The 8 deleted legacy
  rows already had years and are untouched. The year is **not searchable**
  any more (every student would match "2026"): removed from the search
  expression in `searchAdminStudents`, `findMatchingStudentEmails`,
  `findSearchMatches` and `schema.sql`, and the trigram index is rebuilt to
  match (Postgres only uses an expression index when the text matches). A
  year search is a problem for next year.
- **Import**: optional 5th column, `Student Name,Application No,Email,
  Password[,Year]`. Blank or missing = current UTC year; otherwise 4 digits
  within 2 years of it, else that row is rejected with a reason (never
  silently defaulted). Set only on insert; a re-import never changes an
  existing student's year. Both header forms are skipped. To set a year with
  the default password leave the password empty: `Name,App,email,,2025`.
  The import still goes into the college selected at login (the dialog says
  so).
- **Data cleanup (one-off, not a migration)**: deleted the test thread
  "sdklfjs" for a.aditya@myemailinfo.com (messages 7127 and 7128 from
  ashish.kaw@ismedutech.com, reply 25); the student row was kept.
- Tanisha's two codes (Step 29) are a re-application of an old student that
  Edugate will not move past the code step (staff are dealing with the
  Kyrgyz embassy), so her code emails will keep arriving.

Verified locally: `tsc` clean both sides, backend tests 41/41 (new: college
filter and counts wiring, import year cases), frontend build OK. Migration
013 applied to the local dev DB (2281 rows, re-run is a no-op) and the real
queries run against it: all 2275 roster rows page through with no
duplicates, per-college counts add up (1270 + 578 + 427), college filter
returns only that college, searching "tanisha" finds both students with
their college, "2026" no longer matches everyone, and the rebuilt index is
used by the search. The browser UI was not clicked through by me (login
needs the central mailbox password); the layout (new College column, two
button rows, phone width) is for the user to eyeball.

Deploy notes: dump first (server, S3 via `backup-db.sh`, and local), then
`git pull`, apply `backend/migrations/013_year_and_search.sql` as the app
role, `npm run build` in `frontend/`, restart `student-mail.service`. The
migration comes before the restart. Rollback: revert the commit and
redeploy; the migration only fills empty years and rebuilds an index, both
harmless to old code (its year-including search then just skips the index).
If a dump older than 013 is ever restored, re-apply 013.

## Step 29 — One code row per student: older code-only threads count as used

**Status: DEPLOYED 2026-09-29 17:23 UTC** (`ede5408`), backend only, with
no consoles open (user confirmed no usage). `tsc` clean, backend tests
34/34. On the server: `git pull --ff-only`, restart of
`student-mail.service` - API up, central IDLE watcher reconnected, sync
normal, no errors in the log. Checked read-only against prod data with the
new code: searching Tanisha shows 8018 as `code` and 7859 as `used`; the
Code expired count is 1. A pre-deploy `pg_dump` (`manual-20260929T112918Z`)
is in `~/backups` on the server and locally.

Why (user, 2026-09-29): Tanisha Rahaman showed two "code expired" rows.
Read-only prod check (`ssh ubuntu@52.86.63.127`): the messages are
tanisha.rahaman@myemailinfo.com, id 7859 (2026-09-26 10:29 UTC) and id 8018
(2026-09-28 09:48 UTC), both `edugate_kind = code`, no replies. Each code
email arrives as its own thread, so an old expired code stayed in the list
and in the Code expired count after a newer code was requested.

- **`fetchThreadSummaries`** (`thread.ts`): after the summaries are built,
  the newest code time (`code_at`) is found per student (lower-cased email).
  A thread whose badge is `code`, that holds only code emails (`codesOnly`),
  and whose code is older than that student's newest becomes `used` (code,
  `code_at` and validity cleared). Like codes superseded by a registration,
  it leaves the main list and every count and filter, but a search for the
  student still finds it, dimmed.
- **Stays visible**: a code thread where an incoming human message sits
  beside the code. Ties in time are both kept (strict comparison).
  Ordering uses the sent time, so a Migadu-delayed newer code does not hide
  the older one before it arrives.
- **Known limits**: a staff reply is stored separately and does not count as
  "someone wrote", so a superseded code thread staff replied to is still
  hidden (staff do not use Send, so this is theoretical). Counts on "All" and
  "Code expired" drop on deploy - expected.
- **Not changed**: `codeAlerts.ts` (alerts, chart, hot list) already skips
  replaced codes; the roster filter in `studentsAdmin.ts` is per student.
  No migration, no data written, no frontend change.
- **Test**: `reliability.test.mjs` "a student with several code emails shows
  one code row: the newest" - older code hidden, other students unaffected,
  counts and the Code expired filter agree, older row found by search, and an
  older thread with a human message stays visible.

Deploy notes (when the user says so): `git pull`, restart
`student-mail.service` (backend only - no migration, no frontend rebuild),
check `sudo journalctl -u student-mail`, then re-run the read-only query for
Tanisha and confirm one code row.

## Step 28 — Recent problems kept across restarts, solved rows, Migadu login retry

**Status: DEPLOYED 2026-09-28 18:51 UTC** (`75c44c1`) with no consoles
open (00:21 IST). Re-checked before commit: `tsc` clean, backend tests
33/33, frontend build OK. On the server: `git pull`, migration 012 applied
(table + both indexes created), frontend rebuilt, `student-mail.service`
restarted - API up, central IDLE watcher reconnected, syncs normal, no
`[status]` errors. The Recent problems list starts empty (nothing from
before the deploy was stored).

Why (user, 2026-09-26): the status page showed 7 "login rejected (stored
password wrong?)" rows at 7:59/8:02 PM IST, yet inayat.hassan's webmail
opened by hand. Investigated on the server:
- All 2,275 stored passwords match the shared password, these 7 included.
- Migadu itself answered "Authentication failed" (each after about 20 s)
  between 14:29 and 14:33 UTC. Other students logged in fine in the same
  batches, and all 7 logged in fine from the server minutes later. It was a
  short refusal on Migadu's side, not wrong passwords.
- imapflow flags *any* NO to LOGIN as `authenticationFailed`, so the old
  label blamed the password for every refusal.
- The problem list lived in memory for 24 h, so the 13:24 UTC deploy
  restart had wiped the morning's two "INBOX does not exist" failures
  (sabya.sagar1, sai.choudhari - still worth checking in Migadu admin).

User asked for: at least the last 30 problems, a scrollable list, problems
that survive restarts, and solved problems cleared automatically. Agreed
design: mark solved instead of deleting at once (so a transient Migadu
outage stays visible), grey solved rows, delete solved rows after 7 days
and every row after 30 days. Size: about 200-300 bytes a row, so 10,000
rows is about 2-3 MB (the whole prod DB was 14 MB).

- **`status_problems` table** (migration `012_status_problems.sql`, also in
  `schema.sql`). `noteProblem(kind, subject, detail, source)` in
  `systemStatus.ts` stores "Mailbox won't open", "Email could not be
  fetched" and "Central sync failed". At most one open row per
  (kind, subject), enforced by a partial unique index: a repeat (the hot list
  re-failing every few minutes) bumps `times`/`last_at` instead of adding
  rows. The in-memory events still feed the 24 h counters.
- **Solved automatically** (`solveProblems`):
  - mailbox won't open → that student's next successful mailbox check
    (sweep, hot list, or console search);
  - central sync failed → that mailbox's next successful sync
    (`noteSyncSuccess`);
  - email could not be fetched → that Message-ID gets stored
    (`insertMessageForStudent`). The central fetch now also asks for
    `envelope` so a give-up knows its Message-ID; without one it is keyed
    on "central UID n" and just ages out;
  - code expired unused → a fresh code arrived or the student registered
    (`codeAlerts.ts`; the old 24 h limit is gone, the 7 days already loaded
    are used);
  - Migadu delays are records, not problems: shown greyed, never "open".
- **Status page**: the newest 100 rows, open first, then solved and Migadu
  delays by time. Solved rows are greyed with "solved <time>", repeats show
  "· N times since <time>". The table scrolls inside the card (420px, about
  12 rows) with a sticky header. The "could not be fetched" warning now
  counts open give-ups from the database.
- **Login refusals** (`checkStudentMail.ts`): the daily sweep tries a refused
  login once more after 60 s before reporting it. The hot list does not wait
  (it would hold up other waiting students' checks, and it rechecks the same
  mailbox within minutes anyway), and a console search reports at once. The
  label is now "Migadu refused the login (often temporary; if it keeps
  failing, check the password)", with "twice, 1 min apart" for the sweep.

Verified: `tsc` clean on both sides, frontend build OK, backend tests
33/33 (the code-expiry test now also checks open/solved). Migration 012
applied to the local DB; a probe script (session scratchpad `probe.mts`)
recorded, repeated and solved problems against it. The results: a repeat gave
times=2 on one row; a solved row stayed and a new failure opened a fresh
row; open rows sorted first. Probe rows deleted afterwards.

Deploy notes (when the user says so): `git pull`, then apply
`backend/migrations/012_status_problems.sql` as the app role, then
`npm run build` in `frontend/`, then restart `student-mail.service`.
The migration must come before the restart.

## Step 27 — Code expiry alerts, expired-code tracking, square favicon

**Status: DEPLOYED 2026-09-26 13:25 UTC** (`ecc9fd2`) while 3-4 staff
were using the site - judged low risk because staff only copy codes /
login passwords and open the Edugate link (nobody uses Send). Backend
restart: sync caught up with nothing missed, live-update clients
reconnected within seconds. No database migration.

First run on production data (read-only, 0.1 s): 2 codes expired unused
today with no fresh code yet (2 red rows); the previous week had 1-2
expiries a day, all handled - median 19-21 min, one on 09-25 after ~21 h.

Why: staff occasionally miss a verification code, and it expires before
anyone types it into Edugate. The student then has to ask for a fresh
code.

- **Alert rows in the console** (`frontend/src/CodeAlerts.tsx`, placed in
  `Console.tsx`). They sit to the right of the search box and filters,
  above the email pane, so nothing else moves. At most 2 rows show; with
  more, they roll up one every 4 s, pausing under the mouse (reduced motion:
  no roll, "+N more" instead). Clicking a row opens that student's thread.
  - Amber: a code in its last 5 minutes ("expires in 3 min").
  - Red: expired unused ("expired 4 min ago · get fresh code").
  - Red rows (user's rule): fewer than 5 waiting → all shown until
    handled, with a 24 h outer limit so a student who gave up doesn't sit
    there for days; 5 or more → only those from the last 30 min, plus a
    "+N older expired" link that switches the list to "Code expired".
  - Refreshes every 60 s and on every live update; amber turns red on the
    client at the expiry time; countdowns use the server clock.
  - Mockup the user approved (stacked, 2 rows, rolling):
    https://claude.ai/artifact/TM36edvUMe9SL1sbNxv3c1
- **One set of rules, no new table** (`backend/src/codeAlerts.ts`). It's
  all derived from the stored code and login emails, so it survives
  restarts and covers past days. Per code email:
  - used = a login email sent before expiry + 5 min grace (as the hot list);
  - replaced = a newer code came before expiry (not a miss);
  - expired unused = neither, and the expiry time has passed;
  - **handled = a fresh code arrived** (user's definition); time to handle
    = fresh code time − expiry time;
  - still waiting = no fresh code and no registration yet;
  - Migadu-delayed = the code email itself was held > 5 min.
  - Endpoint: `GET /api/codes/alerts` (logged-in college only).
- **Status page** (`systemStatus.ts`, `StatusPage.tsx`,
  `ExpiredCodesChart.tsx`):
  - an amber warning line ("3 verification codes expired unused today; 2
    still waiting for a fresh code.") - a staff miss, not a system fault;
  - one "Recent problems" row per expiry in the last 24 h, with the outcome
    and any Migadu hold;
  - Hot list card (user: the description line looked like a row missing
    its number): first row renamed "Waiting for a registration email",
    description replaced by a "Codes expired unused today" row;
  - an "Expired codes" card: a smooth line (monotone, never overshoots) of
    how many were waiting, every 5 min over the last 6 h (user: only the
    most recent matters) - a fixed sliding window, no browsing back (user:
    "whats gone is gone"); a time label every hour - plus a 7-day
    table (codes, expired unused, handled, median time to fresh code, still
    waiting). Days follow the database time zone, like the other "today"
    figures.
- **Favicon**: the tab icon was the wide ISM Edutech logo squashed into a
  square. Now `public/logos/ism-edutech-icon.svg` (the shield, cropped from
  the same PNG, embedded); the PNG stays as a fallback in `index.html`.

Verified:
- Backend tests 33/33 (5 new in `codeAlerts.test.mjs`); `tsc` clean on
  both sides; frontend build OK; lint adds only 2 set-state-in-effect
  warnings of the kind already present elsewhere.
- **Local end-to-end with test data only, nothing reaching Migadu:** the
  backend ran with `IMAP_HOST`/`SMTP_HOST=127.0.0.1` (port 9, refused) and
  `HOT_ENABLED=false SWEEP_ENABLED=false`, against the local DB with 6
  made-up students (`step27.*@example.test`, `is_test`) on a made-up
  central mailbox, and a session row inserted directly (the normal login
  checks the real mailbox). Alert order and states, the 5-or-more rule,
  status figures and running-count points all matched the test data;
  401 without a session. The user checked both pages in the browser.
  Test scripts: the session scratchpad (`seed.mts`, `five.mts`,
  `cleanup.mts`).
- The local DB was brought up to date for this: migrations 008-011 plus
  `idx_messages_student_email` (applied to production by hand in Step 16).

Deploy notes (when the user says so): `git pull`, `npm run build` in
`frontend/`, restart `student-mail.service`. Open consoles pick up the new
bundle by themselves (`versionCheck.ts`).

## Step 26 — Sync reliability (the batch held back from Step 22)

This was review item 5. It was held because it changes the path every
incoming email takes and had no live test. Now shipped:
- **Real cancellation** (`syncDeadline.ts`, `mailboxSync.ts`, `sync.ts`).
  The 45 s deadline aborts the IMAP work (closing the connection) and
  waits for cleanup before the per-mailbox guard is released. Before, it
  gave up on a stuck sync without stopping it, so the next sync could
  overlap it and write the watermark out of order.
- **Insert + registration status in one transaction** (`sync.ts`,
  `registrationStatus.ts`). A failed status update rolls the email back so
  a retry does both, instead of storing the email with a stale status.
- **A failed pass keeps its progress.** It lists the pass's UIDs first
  (GoDaddy streams FETCH results out of UID order) and saves the watermark
  just below the lowest UID not yet handled, never past an email due for
  retry. If the UID listing itself fails, the pass continues without a
  checkpoint.
- **Emails stored before a failure are still announced** (`SyncFailure`
  carries them; `mailboxSync.ts` broadcasts). The next pass sees them as
  duplicates and never would.

Verified:
- Unit tests 28/28 (20 in `reliability.test.mjs`), `tsc` clean.
- **Live test with no real mailbox:** real imapflow + real Postgres against
  a throwaway local TLS IMAP server (`hoodiecrow-imap`, scratch folder
  only) with 60 synthetic emails, and a scratch database built from
  `schema.sql` (dropped afterwards).
  - Pass 1 was aborted after 20 stored emails. It reported the deadline
    and what it stored, saved the watermark at UID 20, and every UID ≤ 20
    was stored.
  - Pass 2 stored exactly the other 40, each once, with the watermark
    at 60.
  - Pass 3 found nothing new.
  - The synthetic Edugate code email set the student's status in the same
    transaction.
- Test scripts: the session scratchpad `imaptest/` (`server.cjs`,
  `sync-live.mts`).

## Step 25 — Review fixes: live updates never go silent, sandboxed email, backups

These are the first four findings of the full project review (the user
chose 1–4 and said to leave the rest).

1. **Sessions in Postgres** (migration `011_sessions.sql`, `auth.ts`).
   - Before, a backend restart (deploy, crash, reboot) logged every staff
     member out.
   - Now only a SHA-256 of the cookie is stored, with a 7-day expiry as
     before, and an in-memory cache refilled from the table after a
     restart.
   - The migration must be run **as `student_mail_app`** (it owns every
     table); in dev, running it as the OS user left the app without access.

   **Live updates reconnect themselves** (`api.ts` `subscribeToUpdates`,
   `Console.tsx`). A browser never retries an EventSource after an HTTP
   error (401, or 502 while the backend restarts), so open consoles used
   to stop getting new mail with no sign of it. Now:
   - after a give-up, the console checks the session: if signed out it
     goes to the login screen, otherwise it reconnects with backoff
     (1 s … 30 s);
   - every reconnect reloads the list and the open thread, because events
     sent during the gap were missed (no chime for those).
2. **Nightly backup** (`backend/scripts/backup-db.sh`, cron 20:30 UTC).
   - `pg_dump` into `~/backups/nightly/` (600), keeping 14 days.
   - When `~/.backup.env` sets `BACKUP_S3_BUCKET` and the aws CLI exists,
     it also uploads a gpg-encrypted copy (passphrase in
     `~/.backup-passphrase`, which must also be kept off the server).
   - The S3 part needs a bucket + instance IAM role set up by the user in
     the AWS console.
3. **SSE keep-alive** (`server.ts`). A `: ping` every 25 s. nginx's
   60-second idle timeout had been cutting every stream about once a
   minute (44 "upstream timed out" in one day's log). Events sent during
   the ~3 s reconnect gap were lost.
4. **Incoming HTML email in a sandboxed iframe** (`EmailFrame.tsx`).
   - DOMPurify defaults kept `<style>` (which applied to the whole
     console), `<form>`/`<input>` and `<button>`.
   - The frame (`allow-same-origin allow-popups
     allow-popups-to-escape-sandbox`: no scripts, no forms) isolates the
     email's CSS and blocks form submits. It sizes itself to the content,
     so "Show full message" still works. Links open in a new tab.
   - Remote images still load (a user-facing choice, not changed).
   - Replies and plain-text emails render inline as before.

Verified locally:
- Backend tests 13/13 (new `tests/auth.test.mjs`: hash-only storage,
  survives restart, college persisted, logout, expiry). `tsc` clean,
  frontend build clean, oxlint only the 3 known warnings.
- The real session SQL ran against the dev Postgres (5433): a session
  survives a module reload (a simulated restart) with its college, and is
  gone after logout.
- Headless Chromium with synthetic data
  (`/tmp/student-mail-browser/step25.cjs`):
  - a stream drop followed by a 502 → reconnected and the list reloaded;
  - signed out while open → login screen;
  - a hostile email (`<style>` making the page red and hiding rows, plus a
    form posting to another site) → page unaffected, rows visible, zero
    form requests, "Show full message" still shown.

## Step 24 — Application No in the message list

Each list row's top line shows the student's Application No between the
name and the email (`Jane Doe  10012345  jane.doe@…`). Staff type it into
Edugate, and search already matches it. It is small and muted, and never
truncated; the email is what gets shortened. There's no number shown when
the roster has none. The opened email's header shows it too ("Jane Doe ·
Application No **10012345** · email"), bold and selectable with one click
(`ThreadView.tsx` `.thread-app-no`; it comes from the list row via
`Console.tsx`, so it's frontend only). Backend `thread.ts`: the existing per-page name lookup also
returns `admission_id` as `student_app_no` (no extra query, no schema
change). Frontend `MessageList.tsx`, `types.ts`, `App.css`
(`.student-app-no`).

Follow-up: rows went from ~4.5 lines to **two** (user: "each row in left
is 4.5 lines"). Line 1 is name · Application No · email + badge, line 2 is
title + date. Codex's `0e804d1` had stacked the student line
(`display: grid`); it's now one flex line where only the email (then the
name) truncates. Padding is 11px (was 14px), and the line gap 4px (was
9px). On phones (<600px) the email is hidden in rows but stays in the
opened header. Checked in headless Chromium with synthetic rows (Codex's
`/tmp/student-mail-browser` Playwright setup, needs
`LD_LIBRARY_PATH=libs/extracted/usr/lib/x86_64-linux-gnu`): plain rows are
67px at 1440px wide (was ~110px), 64px at 390px, and a very long name
truncates with the number still visible. Verified: backend tests 9/9 (new: rows carry the
number), `tsc` clean, frontend build clean, oxlint only the 3 known
warnings. The list query was run against the dev Postgres (5433).

## Step 23 — Manage students: filter buttons like the console

The user asked for Manage students to match the main console: the same
pill buttons with counts. The **Students / Deleted / Add students**
switcher is now pills (`.view-switch`; the old `.tabs` / `.tab` CSS is
gone). The Students view has **All · Code received · Code expired ·
Registered · Rejected**, with counts for the current search. These replace
the "Show only: code sent, not registered" checkbox. Deleted has no
status buttons.

**Each student is in at most one bucket, decided by their latest Edugate
event** (user-approved; same rule as the console's thread badge):
- **Rejected:** the newest event is a document-rejection email. The
  student is still registered (the account exists) but shows here
  because staff must act.
- **Code received / Code expired:** the newest event is a code, less or
  more than 30 min old. This includes a new code after registration or
  after a rejection.
- **Registered:** the newest event is the registration email.
- No Edugate email yet: All only.

The Edugate status column shows the same bucket. A student in a later
bucket keeps a "registered <date>" note.

Backend `studentsAdmin.ts`: `edugate_state` is computed in SQL (a CTE over
`students` + the newest `messages` rejection). `?status=` replaces
`?registration=pending`, and the first page returns `counts` (all + 4).
There's no schema change. Frontend: `ManageStudents.tsx`
(`RosterFilterButtons` mirrors `FilterButtons.tsx`), `api.ts`, `types.ts`,
`App.css`.

Verified locally: backend tests 8/8 (new `tests/roster.test.mjs`: counts
use scope + search only, the button filters the page, later pages skip the
count query). Backend `tsc` clean, frontend build clean, oxlint only the 3
known warnings. The SQL was run against the isolated dev Postgres (5433):
every button's rows match its count. Five synthetic students, one per rule
(including registered → rejected → Rejected and rejected → new code →
Code received), all landed in the expected bucket, and were deleted
afterwards. Not yet checked in a browser.

## Step 22 — UI polish and status/badge fixes (done; sync part held back)

Codex made a UI pass plus five backend reliability fixes. Claude reviewed
them and fixed its findings. The user then chose to **ship only the
low-risk part** and hold the sync changes (see open items). No schema
change and no migration: rollback is `git revert` plus a restart.

Shipped:
- **Login:** show/hide password toggle; errors announced to screen readers.
- **College picker:** spinner and an "Opening <college>…" message on the
  chosen college; the other buttons are disabled while it opens.
- **Manage students:** a native modal `<dialog>` with focus trapping,
  Escape, and focus restored to the opener. The roster header sticks, and
  the import help is shorter with the details expandable. Escape and
  backdrop clicks are ignored while an import or delete is running, so
  the result panel (rejected rows) isn't lost; the × button still closes.
- **Thread summary box:** SVG icons replace the emoji, and rejection
  "Action needed" is more prominent (`StatusIcon.tsx`).
- **Status page** (`StatusPage.tsx`, `systemStatus.ts`):
  - Shows all central mailboxes.
  - "Sync overdue" uses the backend's rule: 10 min, measured from app
    start if there has been no sync yet.
  - Hot list and sweep show "Unavailable" if their status can't be read.
  - Memory-based counts are labelled approximate, with the window
    explained (`activityCoverage` in the API). The window starts at the
    oldest kept event once the 500-event cap drops older ones.
  - A refresh that fails keeps the last snapshot, with a warning.
  - The "live connection down" warning keeps its outage start time
    across repeated reconnect failures, so the 2-min threshold is reached.
- **Thread badge** (`thread.ts`): in a thread holding both a registration
  and a later document rejection, the newest of those decides the badge.
  A later rejection now shows under Rejected. Student registration status
  is unchanged ("registered" = the account exists).
- **Hot list** (`hotList.ts`): the window stays **35 min** (30-min code
  validity + 5 min for a last-minute registration email to arrive). It is
  now fixed in code; the `HOT_WINDOW_MIN` env setting is no longer read.
- **Tests:** `npm test --prefix backend` now runs
  `backend/tests/reliability.test.mjs` (4 tests: status timing, activity
  window, rejection badge; fake DB).
- `docs/operational-review.md`: Codex's review notes, updated for the split.

Verified locally: backend tests 4/4, backend `tsc` clean, frontend build
clean, oxlint only the 3 known `set-state-in-effect` warnings. Codex
checked the UI in Chromium with synthetic data. The browser checks for the
two Claude UI fixes (Escape during import, `/status` right after a restart)
are still to do on AWS.

## Step 21 — System status page (done)

`https://app.myemailinfo.com/status` - behind the normal console login,
**not linked from the staff screens**, no college needed. User chose the
page only: **no alert emails** and no external uptime service (an earlier
idea: alerts to pakapoor@gmail.com - declined). Refreshes every 30 s.
Shows: overall banner (ok / warning / problem with reasons); central
mailbox sync (live connection, last successful sync, emails today -
**problem** if no sync succeeds for 10 min); hot list (watching now, checks
this hour, recovered today); daily sweep (progress this round, recovered,
mailboxes that failed to open); emails fetched without content (retried /
given up today); Migadu delays (held > 5 min today, longest today / 7
days, from `messages.migadu_hold_seconds`); server (disk - **problem** over
90%, memory, app start, database reachable + email count); recent problems
for 24 h (Migadu delays with queue IDs, mailboxes that won't open, give-ups,
failed syncs).

Backend `systemStatus.ts` (`GET /api/status`, requireAuth): the jobs report
into it - `mailboxSync.ts` (sync success/failure, watcher up/down),
`sync.ts` (retry, give-up), `checkStudentMail.ts` (mailbox failed,
recovered, per source search / sweep / hot), hot list and sweep register
providers for their figures. Events are kept in memory for 24 h (cleared
by a restart); delays come from the database. "Today" is the server's
UTC day. Frontend `StatusPage.tsx`, shown by `App.tsx` when the path is
`/status` (nginx already serves the app for any path).

## Step 20 — Hot list: watch the mailbox while staff wait for registration (done)

User: "whenever code mail comes … check for that email on priority directly
… till either registered mail comes or code expires … because we know
Migadu is not reliable." The person waiting is the staff member who just
typed the code into Edugate and waits for the registration email (login +
password), which normally lands 20-60 s after the code.

`backend/src/hotList.ts`, started with the server. No table: "hot" comes
from the Step 18 columns - `code_sent_at` within `HOT_WINDOW_MIN` (35 =
30 min validity + 5 grace) AND no registration email sent after that code
(`registered_at` NULL or older). So a registration email or expiry drops
the student and a new code (even after registration) makes them hot again.
A 10-s loop checks each hot student's own mailbox (same read-only check as
search/sweep, `source "hot"`, force) every **30 s for the first 5 min**,
then **every 2 min** (user agreed), max 5 in parallel; recovered emails
broadcast `new-mail` → chime, status flips to REGISTERED. Quiet logs
(`[hot] RECOVERED` / `FAILED`, hourly summary). Config: `HOT_ENABLED`,
`HOT_FAST_INTERVAL_S`, `HOT_FAST_MINUTES`, `HOT_INTERVAL_S`,
`HOT_WINDOW_MIN`. UI: "⏳ Waiting for registration email…" under a live code
row in the list and "⏳ Watching the mailbox for the registration email…"
in the code box, while the code is valid. Load: ~70 codes/day, most
register within a minute → a few hundred logins/day.

Tested on the dev DB: fresh code → hot; registration after it → not hot;
new code after registration → hot; 40-min-old code → not hot; an email
removed from the console was recovered from Shakil's real Migadu mailbox
on the first check (~10 s).

This is the simpler, built form of the Step 17b proposal below (no
state machine or table, driven by the status columns).

## Step 17 A — Rolling daily sweep (done)

`backend/src/sweep.ts`, started with the server. Every student's own
INBOX is checked once per `SWEEP_ROUND_HOURS` (24), `SWEEP_BATCH_SIZE`
(5) at a time, spread evenly through the day (user: "divided into chunks
of 5 all through the day") - ~5 every 3 min for ~2300 students, ~2300
logins/day. Uses the same mailbox check as the console search
(`checkStudentMail.ts`: read-only, last 7 days, only missing emails
added, 2-min cooldown shared with search). Order: `students.last_swept_at`
oldest first, never-swept first (migration `008_sweep.sql`, + index), so
it resumes after restarts; a failed check still counts as swept (a wrong
stored password can't block the queue). Recovered emails broadcast
`new-mail` with the student's college → list refresh + chime (user: yes).
Quiet logging: `[sweep] RECOVERED …` / `[sweep] OK … added=N` only when
something was found, `[sweep] FAILED … reason=…` on failures, one
`[sweep] round summary (last 24 h): checked= added= failed=` per round.
≥3 network/timeout failures in one batch → pause 15 min. Off switch:
`SWEEP_ENABLED=false`. `checkStudentMailbox` gained a `source` parameter
(log prefix + quiet mode) and returns the failure reason; console search
behaviour unchanged. Tested on the dev DB with a 36-second round: never-
swept first, auth failures logged and still marked swept, a real mailbox
(Shakil) checked silently, round summary logged. This is also the
tripwire for Step 17b below: `grep -c "sweep] RECOVERED"`.

## Proposal (not built): Step 17b — hot-list polling of student inboxes

Status: **documented contingency, deliberately not built** (decided with
the user 2026-09-25). Build it only if the evidence below changes.

Idea (proposed by another Claude session): when staff are waiting on a
student's Edugate mail, poll that student's own INBOX directly instead of
relying on the copy forwarded to central.

Design as proposed:
- **Hot list table** (`student_id, reason, added_at, last_code_at, stage`).
  - Added when a console search checks a student whose Edugate emails
    show no registration email yet (no code, or code only), or when any
    sync inserts an Edugate code email for a student without a
    registration email. Detection uses the `keyInfo.ts` templates, not
    the sender alone (would need a backend copy or shared module).
  - Removed completely as soon as an Edugate registration email (login +
    password) arrives.
  - Stages: **hot** = poll every 2 min; 40 min after `last_code_at` with
    no registration → **cooling** = poll every 15 min; 6 h after
    `last_code_at` → removed. A new code email puts the student back in
    hot.
- **Poller**: one in-process loop, worker pool (concurrency 5) shared
  with the sweep; per mailbox store UIDVALIDITY + UIDNEXT and skip the
  fetch if unchanged; 45 s timeout; auth/throttle error → back off that
  mailbox 30 min; repeated connection errors → pause the pool 5 min.
  Reuses `checkStudentMail.ts` (EXAMINE, Message-ID diff,
  `insertMessageForStudent()`). Logs `[poller] student=… stage=… new=N
  ms=…` / `[poller] FAILED … reason=…`, no UI errors. Broadcasts
  `new-mail` with `collegeIds` so the chime plays.
- Config: `HOT_INTERVAL_S=120`, `COOLING_INTERVAL_S=900`,
  `HOT_TO_COOLING_MIN=40`, `COOLING_MAX_H=6`.
- Unit tests for the stage transitions (code → hot → cooling → drop;
  registration → removed; new code → hot again).

Why it is not built (measured 2026-09-25):
- 30 random students with Edugate mail, last 3 days (including the
  25 Sep Migadu incident window): **62 of 63** emails in the student
  inboxes were also in the console, and central received each of them
  **within 1 s** of the student inbox (median 0 s). Polling students
  would not have made anything faster.
- 20-email send test between test students: receiver inbox → central
  forwarding **0 s** for all 20; total send → console median 7 s, max
  19.5 s.
- The multi-hour delays seen that day were Migadu holding inbound mail
  **before** it reached any mailbox (student and central alike): 58/59
  Edugate emails were stored < 1 min after acceptance; the long holds
  (45 min – 5 h 44 m) all fall in one incident window on 25 Sep,
  ~11:00–17:40 UTC. Polling cannot beat that.
- Mail "in the student's webmail but not central's" was Migadu's webmail
  display lag - IMAP had it in both mailboxes.
- Migadu holds each recipient's copy independently: for the 5 h 44 m
  Edugate email to Shakil (queue `e158f4f432e3a08b`), **central's** copy
  was stored at 12:32 UTC (held 64 min) but **Shakil's own** copy only at
  17:12 (held 344 min). Central got it 4.7 h *before* the student inbox,
  so student-inbox polling would have been slower there, not faster.
- Costs if built now: constant logins all day (≈50/min with 100 hot
  students) from one IP - a Migadu throttle would also slow the central
  sync; tied to Edugate's exact wording; new table + state machine +
  poller to maintain.

**Tripwire - build it if this happens:** the Step 17 rolling sweep logs
`[sweep] RECOVERED …` for every email found in a student's inbox that
the console didn't have - exactly "the student got it, central didn't".
If that shows up more than a few times a week, or for any Edugate email
during working hours, build this proposal. Check with
`sudo journalctl -u student-mail --since "7 days ago" | grep -c "sweep] RECOVERED"`.
Before building, ask Migadu about login/connection rate limits; consider
a live IDLE connection per hot student instead of 2-min polling (seconds
instead of minutes, one login per student instead of one every 2 min).

## Not yet built / open items

- **Search that tolerates mistyped names** - planned after Step 34; see the future-step note
  under "Step 34 — Flexible student search".
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
