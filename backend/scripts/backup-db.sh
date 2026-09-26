#!/usr/bin/env bash
# Nightly database backup (Step 25). Run by cron on the server as ubuntu:
#   30 20 * * * /home/ubuntu/student-mail/backend/scripts/backup-db.sh
# (20:30 UTC = 02:00 IST / 02:30 Bishkek, the quietest hour.)
#
# 1. pg_dump (custom format) into ~/backups/nightly/, owner-only (600) -
#    dumps hold plaintext mailbox passwords.
# 2. Keeps the newest KEEP_LOCAL dumps there.
# 3. Off-server copy, once configured: if ~/.backup.env sets BACKUP_S3_BUCKET
#    and the aws CLI is installed, the dump is encrypted with gpg (AES256,
#    passphrase in ~/.backup-passphrase) and uploaded. S3 only ever sees the
#    encrypted file. Keep a copy of the passphrase OFF this server - without
#    it the S3 copies can't be restored.
#
# Restore: pg_restore -h 127.0.0.1 -U student_mail_app -d student_mail --clean <dump>
# (from S3: gpg --decrypt --passphrase-file ... <file>.gpg > <dump> first).
set -euo pipefail
umask 077

DIR="$HOME/backups/nightly"
LOG="$HOME/backups/backup.log"
KEEP_LOCAL=14
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$DIR/student_mail-$STAMP.dump"

mkdir -p "$DIR"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

if ! pg_dump -Fc -h 127.0.0.1 -U student_mail_app student_mail > "$FILE"; then
    rm -f "$FILE"
    log "FAILED pg_dump"
    exit 1
fi
log "ok $FILE ($(stat -c %s "$FILE") bytes)"

# Newest KEEP_LOCAL stay; older nightly dumps go.
ls -1t "$DIR"/student_mail-*.dump | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f

# Off-server copy (optional until the S3 bucket exists).
[ -f "$HOME/.backup.env" ] && . "$HOME/.backup.env"
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    if ! command -v aws > /dev/null; then
        log "SKIPPED S3: aws CLI not installed"
        exit 1
    fi
    ENC="$FILE.gpg"
    gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-file "$HOME/.backup-passphrase" -o "$ENC" "$FILE"
    if aws s3 cp --only-show-errors "$ENC" "s3://$BACKUP_S3_BUCKET/student-mail/$(basename "$ENC")"; then
        log "ok uploaded to s3://$BACKUP_S3_BUCKET/student-mail/$(basename "$ENC")"
    else
        log "FAILED S3 upload"
        rm -f "$ENC"
        exit 1
    fi
    rm -f "$ENC"
fi
