#!/usr/bin/env bash
# Reproduce preinstall-bundle.sh's integrity gates without deploying.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST="$ROOT_DIR/bundle-manifest.json"

sha256_file() { sha256sum "$1" | awk '{print $1}'; }
content_sha256() {
	local path=$1 attr
	attr=$(git check-attr text -- "$path" 2>/dev/null | awk -F': ' '{print $3}')
	if [[ "$attr" == set || "$attr" == auto ]]; then
		sed 's/\r$//' "$path" | sha256sum | awk '{print $1}'
	else
		sha256_file "$path"
	fi
}
tree_sha256() {
	local rel_root=$1
	find "$ROOT_DIR/$rel_root" -type f \
		-not -path '*/node_modules/*' \
		-not -path '*/_logs/*' \
		-print | sed "s#^$ROOT_DIR/##" | sort | while IFS= read -r rel; do
		printf '%s  %s\n' "$(content_sha256 "$ROOT_DIR/$rel")" "$rel"
	done | sha256sum | awk '{print $1}'
}
manifest_value() {
	node - "$MANIFEST" "$1" <<'NODE'
const fs = require("fs");
const [manifestPath, path] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
let value = manifest;
for (const part of path.split(".")) value = value?.[part];
if (value === undefined) process.exit(1);
process.stdout.write(String(value));
NODE
}

cd "$ROOT_DIR"
fail=0
check_tree() {
	local rel_root=$1 manifest_path=$2 actual expected
	actual=$(tree_sha256 "$rel_root")
	expected=$(manifest_value "$manifest_path")
	if [[ "$actual" == "$expected" ]]; then
		printf 'ok   %-42s %s\n' "$rel_root" "$actual"
	else
		printf 'FAIL %-42s\n  actual   %s\n  expected %s\n' "$rel_root" "$actual" "$expected"
		fail=1
	fi
}

for item in \
	"bundled/extensions|bundled.extensionsTreeSha256" \
	"bundled/agents|bundled.agentsTreeSha256" \
	"bundled/npm-cache|bundled.npmCacheTreeSha256" \
	"bundled/extensions/pi-diff|sources.git.pi-diff.treeSha256" \
	"bundled/extensions/pi-mcp-adapter|sources.git.pi-mcp-adapter.treeSha256" \
	"bundled/extensions/pi-hermes-memory|sources.git.pi-hermes-memory.treeSha256" \
	"bundled/extensions/pi-background-tasks|sources.git.pi-background-tasks.treeSha256" \
	"bundled/extensions/pi-muselinn-harness|sources.git.pi-muselinn-harness.treeSha256"; do
	IFS='|' read -r rel_root manifest_path <<< "$item"
	check_tree "$rel_root" "$manifest_path"
done

for item in \
	"bundled/extensions/guardrail.ts|sources.guardrail.sha256" \
	"bundled/npm-packages/pi-undo-redo-0.1.1.tgz|sources.npm.pi-undo-redo.sha256" \
	"bundled/npm-packages/pi-dictate-1.0.6.tgz|sources.npm.pi-dictate.sha256" \
	"bundled/npm-packages/pi-mcp-adapter-2.32.1.tgz|sources.npm.pi-mcp-adapter.sha256" \
	"bundled/npm-packages/pi-hermes-memory-0.9.8.tgz|sources.npm.pi-hermes-memory.sha256" \
	"bundled/npm-packages/pi-background-tasks-2.5.0.tgz|sources.npm.pi-background-tasks.sha256" \
	"bundled/npm-packages/pi-muselinn-harness-0.9.22.tgz|sources.npm.pi-muselinn-harness.sha256"; do
	IFS='|' read -r rel manifest_path <<< "$item"
	actual=$(sha256_file "$ROOT_DIR/$rel"); expected=$(manifest_value "$manifest_path")
	if [[ "$actual" == "$expected" ]]; then
		printf 'ok   %-42s %s\n' "$rel" "$actual"
	else
		printf 'FAIL %-42s\n  actual   %s\n  expected %s\n' "$rel" "$actual" "$expected"
		fail=1
	fi
done

echo
[[ $fail -eq 0 ]] && echo "ALL BUNDLE INTEGRITY GATES PASS" || echo "INTEGRITY GATES FAILED"
exit $fail
