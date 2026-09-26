# Mail recovery and registration review

Reviewed against the staff workflow: request a government-site code, register on the student's behalf within 30 minutes, upload documents, then act on any later rejection email. Expected volume is at most 3,000 emails, added gradually. No scaling redesign is recommended.

## Workflow preserved

- The hot list derives membership from a recent code and the absence of a registration timestamp at or after that code. A new code can start another watch.
- Kept the hot-list window at 35 minutes (30-minute code validity plus 5 minutes for a last-minute registration email to arrive), now fixed in code. The legacy HOT_WINDOW_MIN override is no longer read. Membership is evaluated on the next scheduler tick (nominally every 10 seconds); a check already in progress can finish.
- Document rejections do not need hot-list membership. Central sync processes them independently; student search recovery and the daily sweep can recover missed copies from the preceding seven days.
- The registration status means the account was registered, not that all uploaded documents were approved. These remain separate concepts.
- Direct student mailbox checks are read-only. Database uniqueness prevents the normal sync and recovery paths from storing duplicate copies.

## Reliability fixes shipped (Step 22)

1. **Stable outage timing.** Repeated reports of the same disconnected state preserve the initial outage timestamp. Successful backup polls do not reset it. An actual reconnection, followed by a later outage, starts a new timer.

2. **Rejection precedence.** In a shared thread, the most recent recognized registration/rejection event determines the workflow badge. A newer rejection appears in the Rejected filter even when an older registration is present. Student account registration status stays unchanged.

3. **Honest activity counts.** The API exposes the activity window, 500-event cap, retained-event count, and approximate flag. Once the cap drops events, the window starts at the oldest event kept. The status page labels memory-based recovery/retry/failure counts as approximate. Database-backed daily email/delivery totals remain labelled today.

## Sync reliability (shipped in Step 26)

Held back from Step 22 until it had a live test, then shipped: real sync cancellation and serialization, atomic email + registration-state writes, failure checkpoints that list the pass's UIDs first (GoDaddy streams FETCH results out of UID order), and announcing emails stored by a failed pass. Live-tested against a throwaway local IMAP server with synthetic mail and a scratch database: an aborted pass kept its progress, and the next pass fetched exactly the remaining emails, each stored once.

## UI corrections from the review

- Failed status refreshes now visibly mark the retained snapshot as stale.
- All central mailbox connections are displayed, with stale sync distinguished from a connected watcher. A mailbox with no sync yet only counts as overdue 10 minutes after the app started, matching the backend.
- Missing/erroring job status displays Unavailable, rather than Off with invented zero counts.
- Enabled describes job configuration without claiming the last attempt succeeded.
- Sweep coverage is labelled as attempted checks, since failed checks also advance the sweep cursor.
- The Manage students dialog ignores Escape and backdrop clicks while an import or delete is running, so the import result is not lost.

## Verification

Chromium checks (by Codex) used synthetic API responses: password visibility, college selection progress, modal focus wrapping/Escape/focus restoration, sticky roster header, import guidance, delayed thread loads, long names, long email bodies, rejection action details, and status refresh failure. Responsive checks covered 320, 390, 768, and 1440 pixels.

Backend regression tests run with `npm test --prefix backend` (Node 24, experimental module mocking). The shipped suite covers repeated reconnects, capped activity metadata, and linked rejection filtering, using a fake database. These are not live PostgreSQL integration tests.
