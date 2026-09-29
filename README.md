# Student Mail Console

A web console for the staff who handle the mail of about 2,300 students across three colleges
(**KSMA CENTRAL**, **IHSM CENTRAL**, **IHSM ELITE**). Every student has a mailbox at
`myemailinfo.com` (hosted by Migadu) that forwards to one *central* mailbox. The console reads
the central mailbox and shows each student's mail as threads. Staff copy the verification codes
and login details that the Edugate admission portal sends, reply to parents, and add students.

> [`PROJECT.md`](PROJECT.md) has the project history, decisions, and current test notes.
> Diagrams showing stored thread summaries and database test tooling describe the
> planned Steps 31–33; those features are not in this checkout yet.

## The big picture

![System overview: Edugate, parents and Migadu feed the central mailbox; one EC2 server runs nginx, the Node API and PostgreSQL; staff use the React console; nightly encrypted backups go to S3.](docs/diagrams/architecture.svg)

## How mail gets into the console

![Six steps from a forwarded email to a live update in every console, plus three safety nets that read a student's own mailbox.](docs/diagrams/mail-flow.svg)

## What a student's Edugate status means

![Status machine: no Edugate mail, code live, code expired, registered, rejected, and the emails that move a student between them.](docs/diagrams/edugate-status.svg)

## How the console list is built

The current list reads *every message* of the mailbox, groups messages into threads in Node,
and then cuts out 25 rows. Planned Step 32 stores each student's thread summaries so list loads
can use an indexed query. The diagram shows that planned design and its fallback setting.

![Writes queue a student in thread_dirty; the summaries are rebuilt per student into thread_summaries; LIST_MODE picks legacy, shadow or table.](docs/diagrams/thread-summaries.svg)

## Data model

![Tables and links: colleges, students, messages, replies, thread summaries, the rebuild queue, sessions, central mailboxes, status problems.](docs/diagrams/data-model.svg)

## Who may see what

![Every request needs a session, then a chosen college; every query is limited to the session's mailbox and college and to active students.](docs/diagrams/authorization.svg)

## The tests

![node --test runs one process per test file in parallel; every database test file gets its own throwaway PostgreSQL on its own port.](docs/diagrams/tests.svg)

The suite uses Node's test runner. Migration and roster tests start a throwaway PostgreSQL;
Step 33 expands that approach to the backend and adds an `EXPLAIN` test for the hottest queries.
The diagram shows the planned expanded test setup.

## Checks

The current checkout has no root `npm run check` command yet. Run these from the repository
root; Step 33 adds a single command and the coverage, mutation, and load-test scripts.

```bash
npm --prefix backend test
cd backend && npx tsc --noEmit && cd ..
npm --prefix frontend run build
```

## Running it locally

```bash
# 1. PostgreSQL with the schema
psql -f backend/schema.sql            # into an empty database (see PROJECT.md for the role and .env)

# 2. Backend (API on :3001)
cd backend && npm install && npx tsx src/server.ts

# 3. Frontend (Vite dev server)
cd frontend && npm install && npm run dev
```

Settings live in `backend/.env` (not committed; see `backend/.env.example`). The planned
stored-list implementation adds `LIST_MODE` and `THREAD_WORKER`.

## Repository layout

```text
backend/
  src/            API, mail sync, thread building, roster, background jobs
  migrations/     numbered SQL migrations; 014–016 arrive with Steps 31–32
  schema.sql      full schema for a fresh install
  tests/          *.test.mjs and helpers/testdb.mjs for throwaway PostgreSQL
  scripts/        backup scripts; coverage, mutation, and load scripts arrive later
frontend/         React + Vite console
shared/           edugate.ts: the email templates, used by both sides
docs/diagrams/    the SVG diagrams above; generate.py redraws them
PROJECT.md        history, decisions, current status, coverage table
```

The diagrams are plain SVG files. To change one, edit `docs/diagrams/generate.py` and run
`python3 docs/diagrams/generate.py`.

## Production

One EC2 instance runs Node, PostgreSQL and nginx. Code reaches the server only by `git push`
here and `git pull` there. A nightly `pg_dump`, encrypted with gpg, goes to S3. Nothing in this
repository should ever contain credentials or a database dump.
