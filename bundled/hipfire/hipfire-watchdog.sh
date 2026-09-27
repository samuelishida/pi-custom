#!/usr/bin/env bash
# hipfire watchdog: retry failed starts, self-heal loader wedges, keep the model
# resident -- and STOP and say so when the GPU itself needs a reset.
#
# Run by hipfire-watchdog.timer every 60s.
#
# Failure classes seen on this box (2026-09-27):
#
#   1. START RACES. A stale/zombie daemon pid makes `hipfire serve` exit with
#      "FATAL: hipfire daemon already running" and the unit lands in "failed".
#      serve-preclean.sh v2 fixes the cause; this watchdog retries a failed unit.
#
#   2. LOADER WEDGES. The daemon's main thread spins at 60-126% CPU with ZERO
#      read syscalls, GPU idle at its lowest clock (42 MHz), log frozen mid-layer
#      (62/64, 54, 53, 49, 48, 44, 33, 10 all seen), model stuck at null, holding
#      11-15G VRAM. Thread wait channels show the main thread spinning in
#      userspace (wchan 0) while two threads sit in kfd_wait_on_events: a GPU
#      completion that never arrives. Only a process restart clears it.
#
#      NOTE on the "zero I/O" signal: model weights are mmap'd, so layer reads
#      are page faults and do not move rchar. rchar freezing therefore does NOT
#      by itself prove a wedge -- the log failing to advance while the daemon
#      spins in R state is the load-bearing evidence, and it is why this script
#      confirms with a second sample before acting.
#
#   3. DEGRADED GPU STATE. When wedges repeat and no load can complete, restarting
#      hipfire stops helping: that is a driver-level state problem, and the fix is
#      a GPU reset, not another restart. This watchdog gives up after
#      MAX_WEDGES_IN_A_ROW attempts, backs off, and tells the user what to run --
#      an endless restart loop would just hold the GPU hostage and hide the cause.
#
#   4. COLD FIRST REQUESTS. With the model unloaded, the first request pays a full
#      ~90s load inside admission, before any response headers exist, so pi hangs
#      and the user aborts. When the unit is up, idle, nothing is loading and no
#      model is resident, we warm it with a 1-token request.
#
# With --idle-timeout 0 the mid-session unload/reload churn (25 idle unloads in
# serve.log, each a wedge opportunity) is gone, so prewarm + this watchdog cover
# the remaining window: service starts.
set -uo pipefail

UNIT=hipfire.service
HEALTH=http://127.0.0.1:11435/health
WARM=http://127.0.0.1:11435/v1/chat/completions
LOG="$HOME/.hipfire/serve.log"
STATE="$HOME/.hipfire/watchdog.state"
NOTE="$HOME/.hipfire/watchdog.log"
FAILS="$HOME/.hipfire/watchdog.wedgefails"
WEDGE_WINDOW_S=30
WEDGE_CONFIRM_S=20
RESTART_BACKOFF_S=120
MAX_WEDGES_IN_A_ROW=3
GIVE_UP_BACKOFF_S=600
WARM_COOLDOWN_S=600

say() { echo "$(date -u +%FT%TZ) $*" >>"$NOTE"; }

# Desktop notification, best effort: a systemd --user service normally has the
# session bus, but a headless run may not.
desktop_notify() {
	command -v notify-send >/dev/null 2>&1 || return 0
	notify-send -u "${2:-normal}" "hipfire" "$1" >/dev/null 2>&1 || true
}

jsonfield() { # $1=json $2=key
	printf '%s' "$1" | /usr/bin/python3 -c 'import json,sys
try:
    v=json.load(sys.stdin).get(sys.argv[1])
    print("" if v is None else v)
except Exception:
    print("")' "$2" 2>/dev/null
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
# start. Reloading instantly onto a GPU the hung process has just let go of is
# how you get a second wedge.
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

# Prints "frozen" when the daemon's I/O counters AND serve.log are unchanged
# after $2 seconds while the process is in R state.
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

health=$(curl -s --max-time 5 "$HEALTH") || exit 0
model=$(jsonfield "$health" model)
loading=$(jsonfield "$health" loading_model)

# 2. Resident model: healthy. Clear the wedge streak.
if [ -n "$model" ]; then
	echo 0 >"$STATE" 2>/dev/null
	echo 0 >"$FAILS" 2>/dev/null
	exit 0
fi

# 3. Wedge detection: spinner (R) with log and I/O frozen, confirmed twice in the
#    same run so a merely slow layer load is not mistaken for a wedge.
main=$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null)
daemon=$(pgrep -P "${main:-0}" 2>/dev/null | head -1)
if [ -n "${daemon:-}" ] && [ -r "/proc/$daemon/io" ]; then
	if [ "$(sample_daemon "$daemon" "$WEDGE_WINDOW_S")" = frozen ]; then
		echo $(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )) >"$STATE"
		say "frozen sample 1 of 2 (daemon $daemon, R + log frozen ${WEDGE_WINDOW_S}s, loading='${loading}')"
		if [ "$(sample_daemon "$daemon" "$WEDGE_CONFIRM_S")" = frozen ]; then
			now=$(date +%s)
			last=$(cat "$HOME/.hipfire/watchdog.lastrestart" 2>/dev/null || echo 0)
			fails=$(cat "$FAILS" 2>/dev/null || echo 0)
			fails=$((fails + 1))
			echo "$fails" >"$FAILS"

			# 3a. Streak too long: stop restarting and name the real remedy. An
			#     infinite restart loop would thrash the GPU and bury the cause.
			if [ "$fails" -gt "$MAX_WEDGES_IN_A_ROW" ]; then
				if [ $((now - last)) -lt "$GIVE_UP_BACKOFF_S" ]; then
					say "wedge ${fails} in a row without a completed load - backing off (${GIVE_UP_BACKOFF_S}s)"
					exit 0
				fi
				say "wedge ${fails} in a row without a completed load - GPU/driver state looks degraded, retrying once after backoff"
				desktop_notify "hipfire cannot finish a model load (${fails} wedges in a row). The AMD GPU/driver state needs a reset: systemctl --user stop hipfire; echo 1 | sudo tee /sys/class/drm/card2/device/reset; systemctl --user start hipfire" critical
			elif [ $((now - last)) -lt "$RESTART_BACKOFF_S" ]; then
				say "loader wedge confirmed (daemon $daemon) but restart backed off (<${RESTART_BACKOFF_S}s)"
				exit 0
			fi

			date +%s >"$HOME/.hipfire/watchdog.lastrestart"
			say "loader wedge confirmed (daemon $daemon spinning, log frozen; attempt ${fails}) -> clean restart"
			echo 0 >"$STATE"
			restart_clean
			exit 0
		fi
	fi
	# Movement seen: a load is progressing. Healthy.
	echo 0 >"$STATE"
	exit 0
fi
[ -z "${daemon:-}" ] && exit 0

# 4. Up, nothing loading, no model resident: warm it so the next user request
#    pays no ~90s admission-time load (where no keepalive can help, because no
#    headers exist yet).
if [ -n "$loading" ]; then
	exit 0 # a load is in progress (or about to be healed by the branch above)
fi
now=$(date +%s)
last=$(cat "$HOME/.hipfire/watchdog.lastwarm" 2>/dev/null || echo 0)
[ $((now - last)) -lt "$WARM_COOLDOWN_S" ] && exit 0
date +%s >"$HOME/.hipfire/watchdog.lastwarm"
say "unit up, idle, no model resident -> warming"
curl -s --max-time 420 -H 'Content-Type: application/json' \
	-d '{"model":"qwen3.8:27b-mq4-xt","messages":[{"role":"user","content":"warm"}],"max_tokens":1,"stream":false}' \
	"$WARM" >/dev/null 2>&1 || true
exit 0