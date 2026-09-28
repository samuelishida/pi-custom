#!/usr/bin/env bash
# hipfire-use-model.sh <tag>
#
# Make hipfire serve <tag>, and leave it resident.
#
# Why this exists
# ---------------
# Only one model fits in 25.75 GB, so which model hipfire serves is a single
# decision. Two mechanisms could implement it, and this script uses both for
# what each is good at:
#
#   1. `serve.default_model` in ~/.hipfire/config.toml. The systemd unit passes
#      host/port but NO model token, so this key is what the unit prewarms at
#      start. Setting it means the next start comes up on the right model --
#      and switching needs no edit to the unit file at all.
#
#   2. hipfire's own in-daemon reload. `ServeRuntime::ensure_model`
#      (crates/hipfire-cli/src/serve/mod.rs:1114) computes
#      `must_reload = self.current_path != Some(&path)` from the REQUEST's model
#      field and loads that model with its own per-model config
#      (`resolved_for_model`). So a request naming a different tag makes the
#      daemon swap models by itself: no stop/start, no port handoff, no window
#      where a fresh serve races a GPU the hung process just released.
#
# So: if the service is already active we trigger that internal reload with one
# 1-token request for the tag; if it is not, we start the unit and let it
# prewarm the tag we just wrote. Either way we only return success once /health
# reports the tag resident.
#
# The caller is responsible for the VRAM arithmetic: this will happily unload
# a resident model to load the requested one.
set -uo pipefail

TAG="${1:-}"
[[ -n "$TAG" ]] || { echo "usage: hipfire-use-model.sh <tag>" >&2; exit 2; }

UNIT=hipfire.service
CONFIG="$HOME/.hipfire/config.toml"
CATALOG="$HOME/.hipfire/models.toml"
BASE=http://127.0.0.1:11435
WARM_TIMEOUT_S=420
START_TIMEOUT_S=600

say() { printf '%s\n' "$*"; }

# ---- 1. the tag must be a known local model with a file on disk -----------
info=$(python3 - "$CATALOG" "$TAG" <<'PY' 2>/dev/null
import sys, os, tomllib
catalog, tag = sys.argv[1], sys.argv[2]
try:
    with open(catalog, "rb") as fh:
        data = tomllib.load(fh)
except Exception:
    sys.exit(1)
entry = (data.get("models") or {}).get(tag)
if not entry:
    sys.exit(1)
path = entry.get("path") or ""
print(path)
print("yes" if path and os.path.exists(path) else "no")
PY
)
path=$(sed -n 1p <<<"$info")
exists=$(sed -n 2p <<<"$info")
if [[ -z "$path" ]]; then
	say "error: ${TAG} is not in ${CATALOG}; pull or register it first"
	say "       known: $(python3 -c "import tomllib,sys;print(', '.join((tomllib.load(open(sys.argv[1],'rb')).get('models') or {}).keys()))" "$CATALOG" 2>/dev/null)"
	exit 1
fi
if [[ "$exists" != "yes" ]]; then
	say "error: ${TAG} is registered but its file is missing: ${path}"
	exit 1
fi
say "model: ${TAG} -> ${path}"

# ---- 2. point serve.default_model at it (one line, comments preserved) ----
if ! grep -qE '^default_model[[:space:]]*=' "$CONFIG"; then
	say "error: no default_model key in ${CONFIG}; refusing to guess where to write"
	exit 1
fi
current=$(sed -n 's/^default_model[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$CONFIG" | head -1)
if [[ "$current" == "$TAG" ]]; then
	say "config: serve.default_model already ${TAG}"
else
	cp -a "$CONFIG" "$CONFIG.bak-usemodel-$(date -u +%Y%m%dT%H%M%SZ)"
	sed -i "s|^default_model[[:space:]]*=.*|default_model = \"${TAG}\"|" "$CONFIG"
	say "config: serve.default_model ${current:-?} -> ${TAG}"
fi
systemctl --user daemon-reload >/dev/null 2>&1 || true

# ---- 3. make it resident -------------------------------------------------
health_model() {
	curl -s --max-time 5 "$BASE/health" 2>/dev/null |
		python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("model") or "")
except Exception: print("")' 2>/dev/null
}

if [[ "$(health_model)" == "$TAG" ]]; then
	say "ready: ${TAG} already resident"
	exit 0
fi

if systemctl --user is-active --quiet "$UNIT"; then
	# Trigger the in-daemon reload. This one request owns the whole load, so the
	# timeout has to cover a cold load of the target model.
	say "service active: asking the daemon to reload ${TAG} (this is the load; no restart)"
	curl -s --max-time "$WARM_TIMEOUT_S" -H 'Content-Type: application/json' \
		-d "{\"model\":\"${TAG}\",\"messages\":[{\"role\":\"user\",\"content\":\"warm\"}],\"max_tokens\":1,\"stream\":false}" \
		-o /dev/null "$BASE/v1/chat/completions" || true
else
	say "service inactive: starting ${UNIT} (it prewarms ${TAG})"
	systemctl --user start "$UNIT" || { say "error: start failed"; exit 1; }
	deadline=$((SECONDS + START_TIMEOUT_S))
	while ((SECONDS < deadline)); do
		[[ "$(health_model)" == "$TAG" ]] && break
		sleep 3
	done
fi

# ---- 4. verify the END state; a load that did not land must not read as ok -
resident=$(health_model)
if [[ "$resident" == "$TAG" ]]; then
	say "ready: ${TAG} resident"
	exit 0
fi

say "not ready: /health reports model=${resident:-none}, expected ${TAG}"
# Distinguish "still loading" from "loader wedged" so the caller can say
# something true rather than retrying blindly. Wedge signature (2026-09-27):
# daemon in R state with serve.log and its I/O counters frozen.
loading=$(curl -s --max-time 5 "$BASE/health" 2>/dev/null |
	python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("loading_model") or "")
except Exception: print("")' 2>/dev/null)
if [[ -n "$loading" ]]; then
	main=$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null)
	daemon=$(pgrep -P "${main:-0}" 2>/dev/null | head -1)
	if [[ -n "${daemon:-}" && -r "/proc/$daemon/io" ]]; then
		io1=$(grep -E '^(rchar|read_bytes)' "/proc/$daemon/io" 2>/dev/null)
		log1=$(wc -l <"$HOME/.hipfire/serve.log" 2>/dev/null)
		sleep 15
		io2=$(grep -E '^(rchar|read_bytes)' "/proc/$daemon/io" 2>/dev/null)
		log2=$(wc -l <"$HOME/.hipfire/serve.log" 2>/dev/null)
		if [[ -n "$io1" && "$io1" == "$io2" && "$log1" == "$log2" ]]; then
			say "loader looks WEDGED on ${loading} (no progress in 15s); the watchdog will restart the unit"
			exit 3
		fi
	fi
	say "still loading ${loading} (timed out waiting)"
	exit 2
fi
say "no model loading and none resident; check: systemctl --user status ${UNIT}"
exit 1