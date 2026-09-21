# AWS Deployment Handoff — Student Mail Console

Continuing an in-progress AWS deployment against a real deadline. Read this
whole file before doing anything — it has every decision and fact needed to
continue without re-deriving them.

## Deadline / context

- Customer demo happened tonight, 2026-09-21 (~10pm).
- Customer wants a working AWS deployment by **10am tomorrow, 2026-09-22**.
- User is being paid ~INR 10,000/month by the client to cover infra costs.
  Running cost budget worked out earlier: Migadu email ~$29/mo + AWS
  ~$20/mo (post-free-tier) + GoDaddy ~$1/mo ≈ $50/mo ≈ 5000 INR, leaving
  the user ~5000 INR/month margin. This is why cost-consciousness has been
  a real factor in every AWS choice below, not just theoretical.

## Architecture decisions already made (do not re-litigate these)

- **Compute**: one EC2 instance running both the Node/Express backend and
  the built frontend behind Nginx (reverse proxy + static file host + TLS
  termination). Matches this app's existing "intentionally simple"
  architecture — no separate services, no load balancer.
- **Database**: PostgreSQL on the same EC2 instance, NOT RDS. User's
  explicit choice, prioritizing zero extra cost over RDS's managed
  backups. A cron'd `pg_dump` to S3 was suggested as a lightweight backup
  mitigation but not yet set up.
- **TLS**: Certbot (Let's Encrypt) directly on the EC2 instance, NOT an
  ACM-issued cert. ACM certs only attach to AWS-integrated services
  (ALB/CloudFront), which would mean paying for a load balancer
  (~$16-20/mo) just for a "managed" cert — not worth it here. Certbot is
  free; needs a small recurring cron job for renewal (~90-day expiry).
- **Domain**: `myemailinfo.com`, bought today via GoDaddy (same domain
  student mailboxes already use — MX/SPF/DKIM/DMARC managed separately
  through Migadu, unrelated to this app deployment). Plan: subdomain
  `app.myemailinfo.com` via an A record in GoDaddy's DNS panel.
- **Access to the instance**: NO SSH key pair was created. Access is via
  the browser-based **EC2 Instance Connect** (EC2 Console → select
  instance → Connect → "EC2 Instance Connect" tab → Connect). This is a
  deliberate simplicity choice — no local `.pem` file/SSH client needed.
  Important: EC2 Instance Connect's browser terminal connects **from
  AWS's own IP range**, not the user's laptop IP (confirmed via AWS docs:
  e.g. `18.206.107.24/29` for us-east-1) — "My IP" would have broken the
  browser terminal. The security group's SSH rule ended up staying on
  "Anywhere-IPv4" anyway (see "Progress so far" below) - the user
  explicitly decided this after AWS's console rejected mixing the
  EC2-Instance-Connect prefix list with an existing CIDR rule on the
  same line. **Settled, don't revisit.**
- **Secrets**: same `.env`-file approach as local dev, placed on the EC2
  instance with tight file permissions. No Secrets Manager at this scale.
- **Attachments**: currently local disk (`backend/uploads/`) on the
  instance. Not yet decided whether that's acceptable long-term (lost if
  the instance is ever replaced) or should move to S3 — flagged, not
  resolved, not blocking the deadline.

## AWS account facts

- Logged in via AWS **root** account (`garvita@gmail.com`) — flagged as a
  security anti-pattern (root has unrestricted account control), user
  chose to proceed given the deadline rather than set up an IAM user
  first. Worth fixing later, not urgent.
- Region: **us-east-1 (N. Virginia)**.
- Free tier: this AWS account was created on/after July 15, 2025, so it's
  on the newer **credit-based** free tier (broader instance-type
  eligibility, but only for 6 months or until a specific dollar credit
  runs out — not the old "one tiny instance free forever for 12 months"
  model). **User confirmed $100 in free tier credit remaining.**
- Instance type chosen: **`t8i.small`** (2 vCPU, 2GB RAM) — chosen over
  `m7i-flex.large` (2 vCPU, 8GB RAM) specifically because of the $100
  credit constraint: `m7i-flex.large` run 24/7 for the project's ~3-month
  lifetime would cost ~$207 (blows through the credit in ~6 weeks, then
  bills ~$70/mo for real), while `t8i.small` costs ~$54 for the same 3
  months — comfortably inside the $100 budget with room for storage/other
  costs. Post-free-tier ongoing cost for `t8i.small`: ~$18.20/mo compute +
  ~$1.60/mo storage (20GB) ≈ **~$20/month** if it ever runs past the free
  window.
- AMI: Canonical Ubuntu **26.04** LTS, `ami-0b6d9d3d33ba97d99`.
- Storage: **8GB** gp3 (user deliberately chose NOT to bump to 20GB, and
  NOT to enable encryption, to save a step under time pressure — both
  were recommended but declined; not blocking, can be resized later
  without data loss if needed).

## Progress so far (all done, do not repeat)

1. ✅ EC2 instance launched: **instance ID `i-0c104f1bad8f6009b`**
   (name tag `student-mail-app`), `t8i.small`, Ubuntu 26.04, 8GB gp3
   (unencrypted), no key pair. State: Running, 3/3 status checks passed.
   - Security group `launch-wizard-1` (`sg-01e5c8b6562093039`), in
     `vpc-02503db555c2605e7` / `subnet-02c3e8403ab194676`. SSH (22),
     HTTP (80), HTTPS (443) are **all open to Anywhere-IPv4
     (0.0.0.0/0), permanently** — tightening SSH to the EC2 Instance
     Connect prefix list was attempted (found `pl-0e4bcff02b13bef1e`)
     but AWS rejected mixing a prefix list with an existing CIDR rule on
     the same line, and the user explicitly decided to keep SSH on
     Anywhere-IPv4 for speed after weighing the (low, given no key
     pair/no password auth exists to attack) risk. **This is settled —
     do not suggest tightening it again.**
   - Termination protection and instance auto-recovery were recommended
     during launch; not confirmed whether the user actually enabled them.
     Not blocking anything.
2. ✅ Elastic IP allocated and associated: **`52.86.63.127`**
   (`eipalloc-0f934e899bb69eef0`, association `eipassoc-09726c9460e36a4ef`)
   → `i-0c104f1bad8f6009b` (private IP `172.31.13.199`). Confirmed via
   the EC2 console's association details.
3. ✅ GoDaddy DNS A record added and confirmed: `app.myemailinfo.com` →
   `52.86.63.127`. (Propagation status not separately re-checked yet —
   verify with `dig app.myemailinfo.com` or similar before the Certbot
   step, since HTTP-01 validation needs it actually resolving.)
4. ✅ Connected to the instance via the browser-based **EC2 Instance
   Connect** terminal (method confirmed: Public subnet access →
   EC2 Instance Connect, username `ubuntu`, IPv4 `52.86.63.127`).
   **The terminal session is open and this is where all further setup
   commands run.**
5. ✅ `sudo apt update && sudo apt upgrade -y` completed on the instance.
6. ✅ Node.js, PostgreSQL, and Nginx installed via NodeSource LTS setup
   script + `apt install postgresql nginx`. Confirmed versions: Node
   v24.21.0, PostgreSQL 18.6, Nginx 1.28.3.
7. ✅ Code cloned onto the instance via `git clone` from GitHub
   (`https://github.com/pakapoor/student-mail.git`, private repo). Auth
   via a no-expiration classic PAT (`repo` scope only), stored with
   `git config --global credential.helper store` so future `git pull`s
   on this instance won't re-prompt. User plans to eventually wire up
   auto-deploy-on-push to main (not yet built, not blocking now).
8. ✅ `npm install` done in `backend/` (had to run
   `npm install-scripts approve esbuild` first, a newer npm safety gate
   on postinstall scripts — harmless, esbuild is a legit build tool).
   `npm install && npm run build` done in `frontend/` — built cleanly to
   `frontend/dist/` (273KB JS / 15KB CSS, gzip ~86KB/3.6KB).

9. ✅ Database migrated: `pg_dump -F c` taken locally, committed to git
   (user's explicit choice — data is emails/students the org itself
   manages, accepted the tradeoff of a binary dump in repo history),
   pulled onto EC2 via `git pull`, restored with `pg_restore --no-owner`
   into a fresh `student_mail` DB owned by a new `student_mail_app` user
   (no password, mirroring local dev). Had to edit
   `/etc/postgresql/18/main/pg_hba.conf` — changed the two IPv4/IPv6
   *local* connection lines (not the replication ones) from
   `scram-sha-256` to `trust`, then `systemctl restart postgresql`, to
   allow passwordless TCP connection like local dev. Restore was clean,
   no errors. Verified: 2283 students / 38 messages / 17 replies / 3
   colleges — matches expected scale.

10. ✅ `backend/src/server.ts`'s session cookie `secure` flag changed from
   hardcoded `false` to `process.env.NODE_ENV === "production"` (commit
   `bd97821`) — keeps local dev over plain HTTP working while making
   the real deployment's cookie HTTPS-only. `.env` created on the
   instance (`backend/.env`) with real IMAP/SMTP/DB credentials (same as
   local), `DB_PASSWORD` blank (matches trust-auth setup), plus two new
   lines: `FRONTEND_ORIGIN=https://app.myemailinfo.com` and
   `NODE_ENV=production`.

## Next steps, in order (give ONE at a time, per user's explicit request —
## do not dump the whole list on them at once)

11. ✅ Nginx configured (`/etc/nginx/sites-available/student-mail`):
   `/api/` reverse-proxied to backend on `127.0.0.1:3001` (with
   `proxy_buffering off` for the `/api/events` SSE endpoint), `/` serves
   `frontend/dist` static build with `try_files $uri /index.html` SPA
   fallback. DNS confirmed resolving (`dig` → `52.86.63.127`) before
   running Certbot.
12. ✅ HTTPS live: `sudo certbot --nginx -d app.myemailinfo.com` succeeded
   (email `pakapoor@gmail.com`), cert auto-deployed into the Nginx
   config, auto-renewal scheduled by Certbot. **`https://app.myemailinfo.com`
   is now serving over TLS** (backend not yet running as a service, so
   `/api/` will 502 until the next step).

13. ✅ Backend running as a systemd service (`/etc/systemd/system/
   student-mail.service`, `ExecStart` uses `node_modules/.bin/tsx
   src/server.ts` directly since there's no npm start script), enabled
   + started via `systemctl enable --now`. Confirmed via
   `journalctl -u student-mail`: `.env` loaded, listening on
   `127.0.0.1:3001`, IMAP idle watcher connected for
   `central.ksma@myemailinfo.com`, sync loop running cleanly (no
   errors). **The backend is now live on AWS.**

14. ✅ Local dev backend stopped (killed `tsx src/server.ts` and its
   child processes on the local WSL machine) — clean cutover done, AWS
   is now the sole process syncing the IMAP mailboxes. Confirmed no
   `tsx` processes remain locally.

15. ✅ Fixed a real bug found during first browser test: 500 from Nginx
   was a `/home/ubuntu` permission issue blocking `www-data` traversal
   (fixed with `chmod o+x` on the directory chain + `chmod -R o+rX` on
   `frontend/dist`). Then found the frontend's `API_BASE` was hardcoded
   to `http://localhost:3001` (fine for local dev, broken in production)
   — fixed by making it a Vite env var (`VITE_API_BASE`, empty string in
   `frontend/.env.production` so it resolves to relative `/api/...`
   paths through the Nginx proxy), commit `4e95c8e`. Rebuilt frontend on
   EC2 after pulling the fix. **`https://app.myemailinfo.com` now loads
   correctly in the browser.**
16. ✅ Manual end-to-end testing surfaced a real thread-ordering bug (not
   an AWS-specific issue, found during production testing): Closed tab
   was sorting by newest incoming message (`received_at`), not by when
   the thread was actually closed/replied to. Fixed in
   `backend/src/thread.ts`'s `fetchThreadSummaries` — pending threads
   still sort by newest incoming message, but closed threads now sort
   by `resolvedAt` (last reply/follow-up `sent_at` or the Close button's
   timestamp), so a thread closed just now surfaces above one closed
   earlier regardless of when its last email arrived. Follow-up
   messages on closed threads naturally bump sort order too, since they
   share the same `replies` table row that `latestResolvedAt` already
   maxes over. Verified against real closed-thread data with a scratch
   script before cleanup - order is no longer strictly `received_at`.

17. ✅ End-to-end tested on `https://app.myemailinfo.com`: login,
   college picker, student list, rich-text reply, Close button,
   follow-up on a closed thread, pending count badge, and (after the
   fix above) Closed tab ordering — all confirmed working by the user.

## Deferred: auto-deploy-on-push (not urgent, do whenever)

User wants pushes to `main` to auto-deploy to AWS eventually. Site is
live and stable now, no rush - do this next time there's a real code
change to ship. Agreed design (webhook, not cron polling - user wants
the standard pattern):

- A **separate, standalone Node listener** (not part of
  `student-mail.service`) running as its own systemd service, bound to
  `127.0.0.1:9000` only (not exposed directly). Separate from the main
  app specifically so restarting the app doesn't kill the listener
  mid-request.
- **Nginx**: new location block proxying
  `https://app.myemailinfo.com/webhook/deploy` → `127.0.0.1:9000` -
  reuses the existing HTTPS cert, no new security group port needed.
- **GitHub**: repo Settings → Webhooks → add a webhook POSTing to that
  URL on push to `main`, signed with a shared secret (`X-Hub-Signature-256`).
- Listener logic: verify the HMAC signature against the secret (reject
  anything unsigned/forged) → `git pull` → `npm install` in both
  `backend/` and `frontend/` → `npm run build` in `frontend/` →
  `sudo systemctl restart student-mail`. Needs passwordless sudo scoped
  to just that one systemctl command for the `ubuntu` user, or run the
  listener as a user with permission to restart that specific service.
- Kept intentionally minimal: no framework, no third-party webhook
  relay service - one new script, one new systemd unit, one Nginx
  location block, one GitHub webhook config entry.

## Logging/tracing for missed emails (done)

User raised a real concern: if a student email goes missing, there was
no way to diagnose why. `backend/src/sync.ts` had 4 silent `continue`
paths (no message source, no Message-ID, no matching student for the
To address, no parseable sender) that dropped a message with zero
trace - fixed by adding `console.warn` at each with enough context
(UID, Message-ID, To/From, subject) to diagnose a specific missing
email later (commit `52d3ac1`).

Confirmed `/var/log/journal` already existed on the instance, so
systemd journal logging was already persistent across reboots (not
volatile-only). Capped it at `SystemMaxUse=200M` in
`/etc/systemd/journald.conf` so it can't grow to fill the 8GB disk.

**Where to view logs** (on the EC2 instance):
```
sudo journalctl -u student-mail -f                    # live tail
sudo journalctl -u student-mail -n 200 --no-pager      # last 200 lines
sudo journalctl -u student-mail | grep "someone@x.com" # search
sudo journalctl -u student-mail --since "2026-09-22 15:00" --until "2026-09-22 15:30"
```

## Backup strategy: manual EBS snapshots (user's choice)

No automated `pg_dump`/S3 cron set up. User's chosen approach instead:
periodically take manual EBS volume snapshots of the instance via the
EC2 console (covers DB + code + config in one snapshot, not just the
database). Also keeps pushing code changes to git as the code-level
backup/history. Not automated - relies on the user remembering to
snapshot periodically. Revisit if this turns out to be too easy to
forget.

## AWS deployment: DONE

All 9 planned steps are complete. `https://app.myemailinfo.com` is the
live production deployment - backend running as a systemd service,
Postgres with the real migrated data, Nginx + Certbot HTTPS, local dev
backend stopped (clean cutover). No more steps queued here; further
work (auto-deploy-on-push, S3 for attachments, IAM user instead of
root, EBS encryption, backups) is optional hardening, not blocking.

## Things NOT to re-ask the user

- Don't re-ask about instance type, region, storage size, encryption,
  key pair, or database hosting choice — all decided above, some
  deliberately against my own recommendation (encryption, 20GB storage)
  under time pressure. Respect those calls, don't re-litigate.
- Don't suggest RDS or an ALB+ACM again — both explicitly rejected for
  cost reasons already discussed at length.
