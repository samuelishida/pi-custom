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
#   2. LOADER WEDGES. Repeatedly the daemon's main thread spins at ~60-126% CPU
#      with ZERO disk I/O (no read() syscalls at all), GPU idle, log frozen
#      mid-layer (62/64, 49/64, 48/64, 44/64, 33/64 observed), model stuck at
#      null, holding 11-15G VRAM. Only a restart clears it. Signature used here:
#      daemon in R state with I/O and log both frozen, confirmed twice in the
#      same run, then a CLEAN restart (stop -> wait for the GPU to release the
#      VRAM -> start), because reloading onto a GPU the wedged process has just
#      let go of is how you get a second wedge.
#
#   3. COLD FIRST REQUESTS. With the model unloaded, the first user request pays
#      a full ~90s load inside admission (before any response headers), so pi
#      hangs for minutes and the user aborts. The unit prewarms on start; if
#      that prewarm was cancelled the model never becomes resident. When the
#      unit is up, idle, nothing is loading, and the model is null, we warm it
#      with a 1-token request so the next real request is instant.
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
WEDGE_CONFIRM_S=20
RESTART_BACKOFF_S=120

say() { echo "$(date -u +%FT%TZ) $*" >>"$NOTE"; }

jsonget() { # $1=json $2=key
	printf '%s' "$1" | /usr/bin/python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); v=d.get(sys.argv[1])
    print("None" if v is None else v)
except Exception:
    print("None")' "$2" 2>/dev/null
}

# Highest VRAM used across the DRM cards, in bytes (0 if unreadable).
vram_used() {
	local max=0 v
	for f in /sys/class/drm/card*/device/mem_info_vram_used; do
		[ -r "$f" ] || continue
		v=$(cat "$f" 2>/dev/null || echo 0)
		[ "$v" -gt "$max" ] 2>/dev/null && max=$v
	done
	echo "$max"
}

# Stop, wait for the GPU to actually let go of the wedged daemon's VRAM, then
# start.
restart_clean() {
	systemctl --user stop "$UNIT" 2>/dev/null || true
	local i
	for i in $(seq 1 40); do
		[ "$(vram_used)" -lt 536870912 ] && break
		sleep 1
	done
	say "vram after stop: $(( $(vram_used) / 1048576 )) MiB"
	systemctl --user start "$UNIT" 2>/dev/null || say "start after clean stop FAILED"
}

# One frozen sample of the daemon: prints "frozen" when the pid's I/O counters
# AND serve.log are unchanged after $1 seconds while the process is running.
sample_daemon() {
	local pid=$1 secs=$2 io1 log1 state io2 log2
	io1=$(grep -E '^(rchar|read_bytes)' "/proc/$pid/io" 2>/dev/null)
	log1=$(wc -l <"$LOG" 2>/dev/null)
	state=$(ps -p "$pid" -o stat= 2>/dev/null | tr -d ' ')
	sleep "$secs"
	io2=$(grep -E '^(rchar|read_bytes)' "/proc/$pid/io" 2>/dev/null)
	log2=$(wc -l <"$LOG" 2>/dev/null)
	[ -n "$io1" ] && [ "$io1" = "$io2" ] && [ "$log1" = "$log2" ] &&
		[ "${state:0:1}" = "R" ] && echo frozen
}

# 1. A deliberately stopped unit is "inactive" -- the hipfire-lifecycle extension
#    stops it to free VRAM, and we must NOT fight that. Only a unit that FAILED
#    to start gets retried.
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

# 4. Wedge detection: daemon spinning (R) with I/O AND log frozen, confirmed
#    twice within this run so a merely CPU-slow load is not mistaken for a wedge.
main=$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null)
daemon=$(pgrep -P "${main:-0}" 2>/dev/null | head -1)
if [ -n "${daemon:-}" ] && [ -r "/proc/$daemon/io" ]; then
	if [ "$(sample_daemon "$daemon" "$WEDGE_WINDOW_S")" = frozen ]; then
		n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
		echo "$n" >"$STATE"
		say "frozen sample 1 of 2 (daemon $daemon, R + I/O/log frozen ${WEDGE_WINDOW_S}s)"
		if [ "$(sample_daemon "$daemon" "$WEDGE_CONFIRM_S")" = frozen ]; then
			now=$(date +%s)
			last=$(cat "$HOME/.hipfire/watchdog.lastrestart" 2>/dev/null || echo 0)
			if [ $((now - last)) -lt "$RESTART_BACKOFF_S" ]; then
				say "loader wedge confirmed (daemon $daemon) but restart backed off (<${RESTART_BACKOFF_S}s)"
				exit 0
			fi
			date +%s >"$HOME/.hipfire/watchdog.lastrestart"
			say "loader wedge confirmed (daemon $daemon spinning, I/O + log frozen) -> clean restart"
			echo 0 >"$STATE"
			restart_clean
			exit 0
		fi
	fi
	# Movement seen: a load is in progress. Healthy.
	echo 0 >"$STATE"
	exit 0
fi

# 5. No daemon pid found. Nothing to warm for a service that is starting up.
[ -z "${daemon:-}" ] && exit 0

# 6. Up, idle, model null, nothing loading: warm it so the next user request
#    pays no ~90s load. The tail of serve.log is the reliable "is a load in
#    progress" signal: a running or stalled load leaves "loading layer N/64" as
#    the tail, and firing a duplicate request mid-load is a plausible trigger
#    for the cancel/reload that leaves the daemon wedged (2026-09-27).
if tail -n 400 "$LOG" 2>/dev/null | grep -avE "DFlash adaptive-B" | tail -1 | grep -q "loading  *layer"; then
	exit 0
fi
now=$(date +%s)
last=$(cat "$HOME/.hipfire/watchdog.lastwarm" 2>/dev/null || echo 0)
if [ $((now - last)) -lt 600 ]; then
	exit 0
fi
date +%s >"$HOME/.hipfire/watchdog.lastwarm"
say "unit up, model not resident, idle -> warming"
# Foreground (not backgrounded): systemd kills the service's cgroup when the
# script exits, which would cancel a backgrounded load mid-flight.
curl -s --max-time 420 -H 'Content-Type: application/json' \
	-d '{"model":"qwen3.8:27b-mq4-xt","messages":[{"role":"user","content":"warm"}],"max_tokens":1,"stream":false}' \
	"$WARM" >/dev/null 2>&1 || true
exit 0