#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR=${PI_CODING_AGENT_DIR:-}
[[ -n "$AGENT_DIR" ]] || { echo "set PI_CODING_AGENT_DIR to credentialed test agent dir" >&2; exit 2; }
[[ -f "$AGENT_DIR/auth.json" ]] || { echo "missing model auth: $AGENT_DIR/auth.json" >&2; exit 2; }
[[ -f "$AGENT_DIR/extensions/web-search/auth.json" ]] || {
	echo "missing web-search auth: $AGENT_DIR/extensions/web-search/auth.json" >&2
	exit 2
}

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
for command in deepresearch autoresearch; do
	log=$(mktemp "/tmp/pi-integration-$command.XXXXXX.log")
	prompt="/$command Use web_search, then web_fetch one result, and report one short verification result for pi custom E2E."
	if ! (cd "$(mktemp -d /tmp/pi-integration-work.XXXXXX)" && \
		PI_CODING_AGENT_DIR="$AGENT_DIR" "$HOME/.local/bin/pi-custom" --print --no-session --mode json "$prompt") > "$log" 2>&1; then
		echo "$command integration failed; inspect $log" >&2
		exit 1
	fi
	rg -q 'web_search|web_fetch' "$log" || {
		echo "$command completed without an expected web tool call; inspect $log" >&2
		exit 1
	}
	echo "$command integration passed; log: $log"
done
