# Server setup kept in git (Step 53, owner: "3 nines")

Installed on the server **from the git checkout** (never copied from a dev machine), only with the
owner's OK. After `git pull --ff-only` in `~/student-mail`:

```sh
cd ~/student-mail
# Backend unit (Restart=always) + health check timer
sudo cp deploy/systemd/student-mail.service /etc/systemd/system/student-mail.service
sudo cp deploy/systemd/student-mail-health.service deploy/systemd/student-mail-health.timer /etc/systemd/system/
# nginx and PostgreSQL restart after any exit (Ubuntu default: Restart=no)
sudo mkdir -p /etc/systemd/system/nginx.service.d "/etc/systemd/system/postgresql@.service.d"
sudo cp deploy/systemd/overrides/nginx.service.d/restart.conf /etc/systemd/system/nginx.service.d/restart.conf
sudo cp "deploy/systemd/overrides/postgresql@.service.d/restart.conf" "/etc/systemd/system/postgresql@.service.d/restart.conf"
sudo systemctl daemon-reload
sudo systemctl enable --now student-mail-health.timer
sudo systemctl restart student-mail.service
```

Frontend deploys use `deploy/build-frontend.sh` (build into `dist-new`, keep the previous assets, swap) instead
of `npm run build` in place, so the page never 404s mid-build.

Swap (once; the server has 1.9 GB RAM and had none):

```sh
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

- `student-mail.service`: the backend; `Restart=always`, 5 s.
- `student-mail-health.timer` / `.service` / `.sh`: every minute `GET /api/health`. No answer for 2 checks in a
  row = hung: restart. Answers "stalled" (mail not flowing / a job stopped) for 10 in a row: restart (the owner
  is emailed at 5 min by the backend). Every check is appended to `backend/.run/health.log`; the status page shows
  the 30-day uptime from it. Log: `journalctl -u student-mail-health`.

Check: `systemctl list-timers student-mail-health.timer`, `systemctl show student-mail nginx postgresql@18-main -p Restart`,
`swapon --show`.
Undo: `sudo systemctl disable --now student-mail-health.timer`; remove the two `restart.conf` drop-ins; copy back
the previous unit (`Restart=on-failure`); `sudo systemctl daemon-reload`.
