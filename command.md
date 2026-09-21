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
5. 🔄 **IN PROGRESS**: ran `sudo apt update && sudo apt upgrade -y` in
   the instance terminal — waiting on this to finish before moving to
   installing Node.js/PostgreSQL/Nginx. Confirm it completed (and handle
   any keep-local/package-maintainer config-file prompts by accepting
   defaults) before giving the next command.

## Next steps, in order (give ONE at a time, per user's explicit request —
## do not dump the whole list on them at once)

1. **Confirm `apt update && apt upgrade` finished**, then install
   Node.js, PostgreSQL, and Nginx on the Ubuntu 26.04 instance (exact
   commands not yet given - use NodeSource's setup script for a current
   Node LTS, `apt install postgresql nginx`).
2. **Get the code onto the instance.** Not yet decided how — options are
   `git clone` from GitHub (need the repo URL and confirmation the user
   has actually pushed the latest local commits — recall that `git push`
   has failed in *this* sandboxed dev session all along due to missing
   GitHub credentials here, so the user has been pushing manually from
   their own terminal after each step; need to confirm the GitHub remote
   is actually up to date before cloning) or `scp`/`rsync` the local
   working directory directly to the instance. Ask the user which they'd
   prefer, or check for a known GitHub remote URL first.
3. **Install dependencies and build**: `npm install` in both `backend/`
   and `frontend/`, then `npm run build` in `frontend/` for the
   production static build.
4. **Migrate the database**: `pg_dump` the current local dev database,
   transfer the dump to the instance, restore it into a fresh Postgres
   instance there (this restores schema + all real data already imported
   today — the ~1265/573/422 real KSMA/IHSM CENTRAL/IHSM ELITE students,
   test students, etc. — so this should be a full data migration, not a
   fresh `schema.sql` run).
5. **Configure `.env`** on the instance with real IMAP/SMTP/DB
   credentials, set `FRONTEND_ORIGIN` to `https://app.myemailinfo.com`,
   and update the session cookie's `secure: false` (currently hardcoded
   for local plain-HTTP dev in `auth.ts`/`server.ts` — search for
   `res.cookie(SESSION_COOKIE` in `server.ts`) to `true` now that real
   HTTPS will be live.
6. **Set up Nginx**: reverse-proxy `/api` (or however the routes are
   structured) to the Node backend, serve the built frontend's static
   files for everything else, then run **Certbot** for
   `app.myemailinfo.com` once DNS has propagated (check with
   `dig app.myemailinfo.com` or similar before attempting — Certbot's
   HTTP-01 challenge needs the A record to actually resolve first).
7. **Run the backend as a systemd service** (not a bare `npx tsx` in a
   terminal — needs to survive reboots and terminal closes).
8. **Stop the local dev instance's IMAP sync** — this is a real
   correctness requirement, not just cleanup: two processes (local dev +
   AWS) both running IMAP IDLE watchers/polling against the same
   mailboxes would race on the per-mailbox UID watermark added in
   Step 10 of the main project work, potentially corrupting sync state
   or double-processing mail. This must be a clean cutover, not a
   "run both for a while" period.
9. **Test end-to-end on the real domain**: login → college picker →
   Manage Students / CSV import → reply with rich text (Bold/Italic/
   Underline/lists) → Close button → follow-up message on a closed
   thread → confirm pending count badge works — i.e., re-verify
   everything built earlier today, but now on the real production
   deployment, not localhost.

## Things NOT to re-ask the user

- Don't re-ask about instance type, region, storage size, encryption,
  key pair, or database hosting choice — all decided above, some
  deliberately against my own recommendation (encryption, 20GB storage)
  under time pressure. Respect those calls, don't re-litigate.
- Don't suggest RDS or an ALB+ACM again — both explicitly rejected for
  cost reasons already discussed at length.
