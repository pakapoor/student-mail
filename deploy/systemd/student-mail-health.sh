#!/bin/sh
# Step 53: keeps the backend up (owner: "3 nines"). Run every minute by
# student-mail-health.timer.
#
#   GET /api/health ->  200 ok       mail flowing, every job running
#                       503 stalled  the backend answers, but mail is not flowing
#                                    or a job has stopped (the owner is emailed at
#                                    5 min). Restart after STALL_LIMIT minutes in a
#                                    row (a restart cannot fix Migadu being down,
#                                    so this waits longer).
#                       anything else, or no answer within 10 s = down: the
#                                    backend is hung or gone. Restart after
#                                    HANG_LIMIT minutes in a row.
#
# Every check is appended to LOG ("<unix time> ok|stalled|down"); the status
# page turns it into the 30-day uptime figure. The log keeps about 35 days.
STATE_DIR=${HEALTH_STATE_DIR:-/run/student-mail-health}
LOG=${HEALTH_LOG:-/home/ubuntu/student-mail/backend/.run/health.log}
STALL_LIMIT=${HEALTH_STALL_LIMIT:-10}
HANG_LIMIT=${HEALTH_HANG_LIMIT:-2}
URL=${HEALTH_URL:-http://127.0.0.1:3001/api/health}
KEEP_LINES=50000

mkdir -p "$STATE_DIR" 2>/dev/null

count() {
    VALUE=$(cat "$STATE_DIR/$1" 2>/dev/null)
    case "$VALUE" in
        ''|*[!0-9]*) VALUE=0 ;;
    esac
    echo "$VALUE"
}

CODE=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL" 2>/dev/null)

case "$CODE" in
    200) RESULT=ok ;;
    503) RESULT=stalled ;;
    *) RESULT=down ;;
esac

if [ -d "$(dirname "$LOG")" ]; then
    echo "$(date +%s) $RESULT" >> "$LOG" 2>/dev/null
    LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    if [ "$LINES" -gt "$KEEP_LINES" ]; then
        tail -n $((KEEP_LINES - 5000)) "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    fi
fi

if [ "$RESULT" = ok ]; then
    echo 0 > "$STATE_DIR/stalled"
    echo 0 > "$STATE_DIR/down"
    exit 0
fi

STALLED=$(( $(count stalled) + 1 ))
echo "$STALLED" > "$STATE_DIR/stalled"

if [ "$RESULT" = down ]; then
    DOWN=$(( $(count down) + 1 ))
else
    DOWN=0
fi
echo "$DOWN" > "$STATE_DIR/down"

echo "student-mail health: $RESULT (stalled $STALLED/$STALL_LIMIT, not answering $DOWN/$HANG_LIMIT)"

if [ "$DOWN" -ge "$HANG_LIMIT" ] || [ "$STALLED" -ge "$STALL_LIMIT" ]; then
    echo "student-mail health: restarting the backend ($RESULT)"
    echo 0 > "$STATE_DIR/stalled"
    echo 0 > "$STATE_DIR/down"
    systemctl restart student-mail.service
fi
