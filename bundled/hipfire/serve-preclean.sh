#!/usr/bin/env bash
# Clear the state that makes `hipfire serve` refuse to start. v2.
#
# Failure mode this fixes (seen 2026-09-27 in `systemctl --user restart hipfire`):
#     hipfire serve stopped (PID A) ...
#     reaped orphan daemon processes and freed port 11435
#     FATAL: hipfire daemon already running (PID B). Run `kill B` and retry.
# The stop path reaps the orphan daemon, but the dead pid can linger briefly as
# a ZOMBIE -- and `kill -0` succeeds on a zombie, so `hipfire serve` treats it
# as "already running" and exits 1, failing the whole unit. ~/.hipfire/daemon.pid
# also outlives its process. v1 of this script only handled serve.pid + the port.
#
# v2: covers BOTH pid records, verifies the target is really a hipfire process
# (pid reuse must not kill an unrelated process), waits for the pid to FULLY
# disappear from /proc (not merely get signalled), frees the port, and drops the
# stale records. Runs as ExecStartPre so a restart is self-healing.
set -uo pipefail

# Signal $1, then wait until it is gone from /proc. A zombie still answers
# kill -0, so /proc/<pid> presence is the only reliable "still here" test. The
# kernel reaps orphans quickly once their parent is gone, but a stop/start race
# can catch the window, hence the wait.
kill_and_wait() {
	local pid=$1
	kill "$pid" 2>/dev/null || true
	for _ in $(seq 1 20); do
		[ -d "/proc/$pid" ] || return 0
		sleep 0.5
	done
	echo "serve-preclean: force-killing $pid"
	kill -9 "$pid" 2>/dev/null || true
	for _ in $(seq 1 10); do
		[ -d "/proc/$pid" ] || return 0
		sleep 0.5
	done
	echo "serve-preclean: WARNING pid $pid still present after SIGKILL"
}

# Only ever kill a process that really is hipfire's. A stale record can hold a
# pid that the kernel has since reused for something unrelated.
is_hipfire_pid() {
	local pid=$1
	tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null |
		grep -qE '\.hipfire/bin/(hipfire|daemon)|hipfire serve'
}

for rec in "$HOME/.hipfire/daemon.pid" "$HOME/.hipfire/serve.pid"; do
	[ -f "$rec" ] || continue
	case "$rec" in
	*.json)
		pid=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid",""))' "$rec" 2>/dev/null || true)
		;;
	*)
		pid=$(tr -dc '0-9' <"$rec" 2>/dev/null || true)
		;;
	esac
	if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
		if is_hipfire_pid "$pid"; then
			echo "serve-preclean: killing stale pid $pid ($rec)"
			kill_and_wait "$pid"
		else
			echo "serve-preclean: pid $pid in $rec is NOT a hipfire process - leaving it alone"
		fi
	fi
	rm -f -- "$rec"
done

# Whatever else still holds the serving port (an orphan may have dropped out of
# both pid records).
if command -v fuser >/dev/null 2>&1; then
	fuser -k 11435/tcp 2>/dev/null || true
fi
for _ in $(seq 1 20); do
	ss -ltn 2>/dev/null | grep -q ':11435 ' || break
	sleep 0.5
done

exit 0