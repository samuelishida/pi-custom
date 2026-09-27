#!/usr/bin/env bash
# hipfire watchdog: retry failed starts, self-heal loader wedges, keep the
# model resident. Run by hipfire-watchdog.timer (every 60s).
#
# Failure classes seen on this box (2026-09-27):
#
#   1. START RACES. After a stop, a stale/zombie daemon pid makes
#      `hipfire serve` exit with "FATAL: hipfire daemon already running" and
#      the unit lands in "failed". serve-preclean.sh v2 fixes the cause; this
#      watchdog clears and retries a failed unit so nobody has to do it by hand.
#
#   2. LOADER WEDGES. Twice in one day the daemon's main thread spun at
#      ~100-126% CPU with ZERO disk I/O, GPU idle, log frozen mid-layer
#      (62/64 once, 44/64 once), model stuck at null, holding 11-15G VRAM.
#      Recoverable only by restarting the unit. Signature used here: daemon in
#      R state with I/O and log both frozen across a 30s window, twice in a row.
#
#   3. COLD FIRST REQUESTS. With the model unloaded, the first user request
#      pays a full ~90s load inside admission (before any response headers), so
#      pi hangs for minutes and the user aborts. The unit prewarms on start, but
#      if that prewarm was cancelled the model never becomes resident. When the
#      unit is up, idle, and the model is null, we warm it with a 1-token
#      request so the next real request is instant.
#
# With --idle-timeout 0 the mid-session unload/reload churn (25 idle unloads in
# serve.log, each a wedge opportunity) is gone, so this watchdog plus prewarm
# covers the remaining window: service starts.
set -uo pipefail

UNIT=hipfire.service
STATS=http://127.0.0.1:11435/stats
WARM=http://127.0.0.1:11435/v1/chat/completions
LOG="$HOME/.hipfire/serve.log"
STATE="$HOME/.hipfire/watchdog.state"
NOTE="$HOME/.hipfire/watchdog.log"
WEDGE_WINDOW_S=30
RESTART_BACKOFF_S=300

say() { echo "$(date -u +%FT%TZ) $*" >>"$NOTE"; }

jsonget() { # $1=json $2=key
	printf '%s' "$1" | /usr/bin/python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); v=d.get(sys.argv[1])
    print("None" if v is None else v)
except Exception:
    print("None")' "$2" 2>/dev/null
}

# 1. A deliberately stopped unit is "inactive" -- the hipfire-lifecycle
#    extension stops it to free VRAM, and we must NOT fight that. Only a unit
#    that FAILED to start gets retried.
if systemctl --user is-failed --quiet "$UNIT" 2>/dev/null; then
	say "unit in failed state -> reset-failed + start"
	systemctl --user reset-failed "$UNIT"
	systemctl --user start "$UNIT" || say "start retry FAILED"
	exit 0
fi
systemctl --user is-active --quiet "$UNIT" || exit 0

stats=$(curl -s --max-time 5 "$STATS") || exit 0
model=$(jsonget "$stats" model)
queue=$(jsonget "$stats" queue_depth)

# 2. Model resident: healthy. Clear wedge sightings.
if [ "$model" != "None" ]; then
	echo 0 >"$STATE" 2>/dev/null
	exit 0
fi

# 3. Model is null. If a request is queued, hipfire is working on it -- hands off.
[ "$queue" = "None" ] && queue=0
[ "$queue" -gt 0 ] && exit 0

# 4. Wedge detection: daemon spinning (R state) with I/O AND log frozen.
main=$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null)
daemon=$(pgrep -P "${main:-0}" 2>/dev/null | head -1)
if [ -n "${daemon:-}" ] && [ -r "/proc/$daemon/io" ]; then
	io1=$(grep -E '^(rchar|read_bytes)' "/proc/$daemon/io" 2>/dev/null)
	log1=$(wc -l <"$LOG" 2>/dev/null)
	state1=$(ps -p "$daemon" -o stat= 2>/dev/null | tr -d ' ')
	sleep "$WEDGE_WINDOW_S"
	io2=$(grep -E '^(rchar|read_bytes)' "/proc/$daemon/io" 2>/dev/null)
	log2=$(wc -l <"$LOG" 2>/dev/null)
	state2=$(ps -p "$daemon" -o stat= 2>/dev/null | tr -d ' ')

	if [ "$io1" = "$io2" ] && [ "$log1" = "$log2" ] &&
		[ "${state1:0:1}" = "R" ] && [ "${state2:0:1}" = "R" ]; then
		n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
		echo "$n" >"$STATE"
		# 4a. A load that is merely CPU-slow can freeze the log for a while;
		#     require two consecutive sightings before restarting.
		if [ "$n" -lt 2 ]; then
			say "possible loader wedge (daemon $daemon, R + I/O/log frozen ${WEDGE_WINDOW_S}s) - sighting 1"
			exit 0
		fi
		# 4b. Back off: never restart more often than every RESTART_BACKOFF_S.
		now=$(date +%s)
		last=$(cat "$HOME/.hipfire/watchdog.lastrestart" 2>/dev/null || echo 0)
		if [ $((now - last)) -lt "$RESTART_BACKOFF_S" ]; then
			say "loader wedge confirmed (daemon $daemon) but restart backed off (<${RESTART_BACKOFF_S}s)"
			exit 0
		fi
		date +%s >"$HOME/.hipfire/watchdog.lastrestart"
		say "loader wedge confirmed (daemon $daemon spinning, I/O + log frozen ${WEDGE_WINDOW_S}s) -> restart"
		echo 0 >"$STATE"
		systemctl --user restart "$UNIT" || say "restart FAILED"
		exit 0
	fi
	# 4c. Movement happened (a load in progress): healthy, clear sightings.
	echo 0 >"$STATE"
	[ "$log1" != "$log2" ] && exit 0
fi

# 5. Up, idle, model null: warm it so the next user request pays no load.
#    Foreground (not backgrounded): a backgrounded curl would be killed with
#    the oneshot service's cgroup when this script exits, cancelling the load
#    mid-flight -- the exact failure mode we are trying to prevent.
say "unit up, model not resident, idle -> warming"
curl -s --max-time 420 -H 'Content-Type: application/json' \
	-d '{"model":"qwen3.8:27b-mq4-xt","messages":[{"role":"user","content":"warm"}],"max_tokens":1,"stream":false}' \
	"$WARM" >/dev/null 2>&1 || true
exit 0