# Working on Student Mail Console (for Claude, Codex and other agents)

Read `PROJECT.md` first: its "Start here" section has the current state, the step index and the
prod runbook. `README.md` has the architecture diagrams, a glossary and the local-dev gotchas.

## Rules the owner has set (do not relax them without being told)

- **Confirm before every edit.** State the plan in plain terms and get explicit approval before
  touching any file, every time, even mid-task.
- **No commit until the owner says "check in".** Finish the code, let the owner test locally, then
  commit and push only when told. Every check-in includes the matching `PROJECT.md` entry (kept up
  to date while you work) in the same commit. Commit titles start with the step number
  (`Step 36: ...`).
- **Run the full check before every commit and report the result:** backend `npx tsc --noEmit`,
  `npm --prefix backend test` (all tests), frontend `npx tsc -b --noEmit` and
  `npm --prefix frontend run build`.
- **Every change gets a risk analysis table** in its `PROJECT.md` section (Area, Risk, Why, and an
  overall rating).
- **Deploy to prod only when the owner says so, and only through git:** `git push` here, `git pull
  --ff-only` on the server. Never copy files to the server. Prod runbook: `PROJECT.md`.
- **Never put secrets, passwords or database dumps in the repository or in chat.** Dumps hold
  plaintext mailbox passwords; backups stay under `~/backups` on the server.
- Minimal diffs; do not rewrite working code without a reason. Backend edits need a restart of the
  dev server (no hot reload).

## Product context that changes how you judge risk

- Staff only copy codes and login passwords and click the Edugate link. Nobody uses Send, so
  reply/follow-up paths matter less than the list, search and live updates.
- Logins live in PostgreSQL (the `sessions` table), so restarting the backend does not log anyone
  out. A restart briefly drops the live-update (SSE) stream; the console reconnects by itself.
- Frontend-only deploys need no backend restart. Open tabs reload themselves onto the new build
  when no thread is open.
- Read-only investigation on prod (logs, SELECTs) is fine. Changes on the server need approval.

## Where things are

`PROJECT.md` (state, decisions, history), `README.md` (diagrams, glossary, local setup),
`backend/src/` (API, mail sync, search, roster), `frontend/src/` (React console),
`shared/edugate.ts` (email templates used by both sides), `command.md` (historical AWS setup log).
