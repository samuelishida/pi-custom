#!/usr/bin/env bash
# Apply the hipfire prefill-keepalive patch, build it, and install it.
#
# WHY
# ---
# `hipfire serve` writes the role chunk to the SSE stream immediately and then
# NOTHING until the first generated token. A cold prefill therefore leaves the
# connection byte-silent for minutes, and any client that enforces an
# idle-between-chunks timeout declares it dead and aborts. undici -- Node's
# fetch, and what pi's HTTP client uses -- defaults to a 300s bodyTimeout that
# is not reachable from pi's config.
#
# Measured cold prefills on this box (qwen3.8:27b-mq4-xt):
#   20k prompt tokens ->  17s
#   60k prompt tokens ->  85s
#   90k prompt tokens -> 207s
#   120k prompt tokens -> past 300s
# Fitting t ~= 2.56e-8*n^2 puts 300s at ~108k tokens, so every prompt above that
# died mid-prefill and each retry re-ran the identical cold prefill.
#
# WHAT THE PATCH DOES
# -------------------
# Adds a `PrefillHeartbeat` to crates/hipfire-cli/src/serve/http.rs that writes
# `: keepalive\n\n` SSE comment frames every 15s for the life of the request.
# Conforming SSE parsers discard comment lines (the OpenAI SDKs use
# eventsource-parser), so model output is byte-for-byte unchanged, but every
# frame resets the client's idle timer and the stream survives a 300s+ prefill.
#
# USAGE
#   apply-hipfire-prefill-keepalive.sh              # apply + build + install
#   apply-hipfire-prefill-keepalive.sh --check      # report drift, change nothing
#   apply-hipfire-prefill-keepalive.sh --no-restart # skip the service restart
#   --src DIR      hipfire source checkout (default: ~/.hipfire/src)
#   --bin-dir DIR  installed binaries      (default: ~/.hipfire/bin)
set -euo pipefail

SRC_DIR="$HOME/.hipfire/src"
BIN_DIR="$HOME/.hipfire/bin"
SERVICE="hipfire"
PATCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bundled/hipfire/prefill-keepalive.patch"
CHECK_ONLY=0
RESTART=1

while [ $# -gt 0 ]; do
	case "$1" in
	--check) CHECK_ONLY=1 ;;
	--no-restart) RESTART=0 ;;
	--src)
		SRC_DIR="$2"
		shift
		;;
	--bin-dir)
		BIN_DIR="$2"
		shift
		;;
	-h | --help)
		sed -n '2,40p' "$0"
		exit 0
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 2
		;;
	esac
	shift
done

die() {
	echo "ERROR: $*" >&2
	exit 1
}

[ -f "$PATCH" ] || die "patch not found: $PATCH"
# A linked worktree has `.git` as a file, not a directory, so ask git instead of
# testing for a directory.
git -C "$SRC_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout: $SRC_DIR"

TARGET_REL="crates/hipfire-cli/src/serve/http.rs"
[ -f "$SRC_DIR/$TARGET_REL" ] || die "missing $SRC_DIR/$TARGET_REL"

cd "$SRC_DIR"

# Is the patch already applied? A reverse-apply that succeeds means yes.
if git apply --check --reverse "$PATCH" >/dev/null 2>&1; then
	APPLIED=1
else
	APPLIED=0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
	if [ "$APPLIED" -eq 1 ]; then
		echo "OK   prefill keepalive patch is applied in $SRC_DIR"
		exit 0
	fi
	echo "DRIFT prefill keepalive patch is NOT applied in $SRC_DIR" >&2
	exit 1
fi

if [ "$APPLIED" -eq 1 ]; then
	echo "already applied; nothing to patch"
else
	# Fail loudly rather than half-applying: if the forward check fails, the
	# checkout has diverged (upstream moved or local edits overlap) and a
	# human should look at it.
	git apply --check "$PATCH" || die "patch does not apply to $SRC_DIR (diverged checkout?)"
	git apply "$PATCH"
	echo "applied the prefill keepalive patch"
fi

echo "building hipfire-cli (release; recompiles only the changed crate) ..."
# The crate needs no ROCm env to *build* the CLI, but inherit it when present.
HIPFIRE_ROCM_PATH="${HIPFIRE_ROCM_PATH:-/opt/rocm}" cargo build --release -p hipfire-cli
BUILT="$SRC_DIR/target/release/hipfire"
[ -x "$BUILT" ] || die "build produced no binary at $BUILT"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
INSTALLED="$BIN_DIR/hipfire"

if [ -f "$INSTALLED" ] && cmp -s "$BUILT" "$INSTALLED"; then
	echo "installed binary already matches the build; no install needed"
else
	# A running service holds the inode, so copying over it fails with ETXTBSY.
	# Stop first, back up, install, then start.
	was_active=0
	if systemctl --user is-active --quiet "$SERVICE"; then
		was_active=1
		echo "stopping $SERVICE ..."
		systemctl --user stop "$SERVICE"
	fi
	if [ -f "$INSTALLED" ]; then
		cp -p "$INSTALLED" "$INSTALLED.bak-keepalive-$TS"
		echo "backed up: $INSTALLED.bak-keepalive-$TS"
	fi
	cp "$BUILT" "$INSTALLED"
	echo "installed: $INSTALLED ($(md5sum "$INSTALLED" | cut -d' ' -f1))"
	if [ "$was_active" -eq 1 ] && [ "$RESTART" -eq 1 ]; then
		systemctl --user start "$SERVICE"
		sleep 3
		systemctl --user is-active --quiet "$SERVICE" || die "$SERVICE failed to start"
		echo "$SERVICE restarted"
	fi
fi

echo
echo "verify with:  grep -c '^: keepalive' on a raw capture of a >15s request"
echo "  curl -sS -N --data-binary @probe.json -H 'Content-Type: application/json' \\"
echo "       http://127.0.0.1:11435/v1/chat/completions | grep -c '^: keepalive'"
