#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST="$ROOT_DIR/bundle-manifest.json"

if [[ -n "${PI_CODING_AGENT_DIR:-}" ]]; then
	AGENT_DIR=$PI_CODING_AGENT_DIR
elif [[ -n "${PI_AGENT_DIR:-}" ]]; then
	echo "warning: PI_AGENT_DIR is compatibility alias; use PI_CODING_AGENT_DIR" >&2
	AGENT_DIR=$PI_AGENT_DIR
else
	AGENT_DIR="$HOME/.pi/agent"
fi

WITH_BROWSER=false
if [[ "${1:-}" == "--with-browser" ]]; then
	WITH_BROWSER=true
elif [[ $# -gt 0 ]]; then
	echo "usage: $0 [--with-browser]" >&2
	exit 2
fi

[[ -f "$MANIFEST" ]] || { echo "missing bundle manifest: $MANIFEST" >&2; exit 1; }
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$MANIFEST"

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

guardrail_expected=$(manifest_value sources.guardrail.sha256)
guardrail_bytes=$(manifest_value sources.guardrail.bytes)
[[ "$(stat -c '%s' "$ROOT_DIR/bundled/extensions/guardrail.ts")" == "$guardrail_bytes" ]] || {
	echo "guardrail byte count mismatch" >&2; exit 1;
}
[[ "$(sha256_file "$ROOT_DIR/bundled/extensions/guardrail.ts")" == "$guardrail_expected" ]] || {
	echo "guardrail SHA-256 mismatch" >&2; exit 1;
}

for item in \
	"pi-undo-redo|bundled/npm-packages/pi-undo-redo-0.1.1.tgz|sources.npm.pi-undo-redo.sha256" \
	"pi-dictate|bundled/npm-packages/pi-dictate-1.0.6.tgz|sources.npm.pi-dictate.sha256" \
	"pi-observational-memory|bundled/npm-packages/pi-observational-memory-3.0.4.tgz|sources.npm.pi-observational-memory.sha256" \
	"pi-mcp-adapter|bundled/npm-packages/pi-mcp-adapter-2.32.1.tgz|sources.npm.pi-mcp-adapter.sha256" \
	"pi-hermes-memory|bundled/npm-packages/pi-hermes-memory-0.9.8.tgz|sources.npm.pi-hermes-memory.sha256" \
	"pi-background-tasks|bundled/npm-packages/pi-background-tasks-2.5.0.tgz|sources.npm.pi-background-tasks.sha256" \
	"pi-muselinn-harness|bundled/npm-packages/pi-muselinn-harness-0.9.22.tgz|sources.npm.pi-muselinn-harness.sha256"; do
	IFS='|' read -r name archive manifest_path <<< "$item"
	[[ "$(sha256_file "$ROOT_DIR/$archive")" == "$(manifest_value "$manifest_path")" ]] || {
		echo "$name tarball SHA-256 mismatch" >&2; exit 1;
	}
done

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
	[[ "$(tree_sha256 "$rel_root")" == "$(manifest_value "$manifest_path")" ]] || {
		echo "$rel_root tree SHA-256 mismatch" >&2; exit 1;
	}
done

mkdir -p "$AGENT_DIR" "$AGENT_DIR/extensions" "$AGENT_DIR/skills" "$AGENT_DIR/prompts"
timestamp=$(date -u +%Y%m%dT%H%M%S%N)
backup_dir="$AGENT_DIR/.backup-$timestamp"
mkdir -p "$backup_dir"
backup_list=$(mktemp "$AGENT_DIR/.backup-list.XXXXXX")
stage_dir=$(mktemp -d "$AGENT_DIR/.bundle-stage.XXXXXX")
cleanup() {
	rm -f "$backup_list"
	rm -rf "$stage_dir"
}
trap cleanup EXIT

backup_path() {
	local dest=$1 rel=${1#"$AGENT_DIR/"}
	[[ -e "$dest" || -L "$dest" ]] || return 0
	mkdir -p "$backup_dir/$(dirname "$rel")"
	cp -a "$dest" "$backup_dir/$rel"
	printf '%s\n' "$rel" >> "$backup_list"
}

replace_path() {
	local staged=$1 dest=$2
	backup_path "$dest"
	if [[ -e "$dest" || -L "$dest" ]]; then rm -rf -- "$dest"; fi
	mkdir -p "$(dirname "$dest")"
	mv "$staged" "$dest"
}

cp -a "$ROOT_DIR/bundled/extensions/guardrail.ts" "$stage_dir/guardrail.ts"
cp -a "$ROOT_DIR/bundled/extensions/custom-header.ts" "$stage_dir/custom-header.ts"

for src in "$ROOT_DIR"/bundled/extensions/*/; do
	name=$(basename "$src")
	cp -a "$src" "$stage_dir/$name"
	if [[ ! -f "$stage_dir/$name/index.ts" && ! -f "$stage_dir/$name/index.js" ]]; then
		node - "$stage_dir/$name/package.json" <<'NODE'
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!p.pi?.extensions?.length) process.exit(1);
NODE
	fi
done

for src in "$ROOT_DIR"/bundled/skills/*; do
	name=$(basename "$src")
	cp -a "$src" "$stage_dir/skills-$name"
done
for src in "$ROOT_DIR"/bundled/agents/*.md; do cp -a "$src" "$stage_dir/agents-$(basename "$src")"; done
for src in "$ROOT_DIR"/bundled/prompts/*.md; do cp -a "$src" "$stage_dir/prompts-$(basename "$src")"; done

for name in bash-guard browser web-fetch pi-undo-redo pi-dictate pi-observational-memory pi-interactive-subagents pi-diff pi-mcp-adapter pi-hermes-memory pi-background-tasks pi-muselinn-harness; do
	if [[ -f "$stage_dir/$name/package-lock.json" ]]; then
		(cd "$stage_dir/$name" && npm ci --omit=dev --ignore-scripts --offline --cache "$ROOT_DIR/bundled/npm-cache" > "$ROOT_DIR/.preinstall-$name.log" 2>&1) || {
			echo "offline dependency install failed: $name (see .preinstall-$name.log)" >&2
			exit 1
		}
	fi
done

if [[ -f "$AGENT_DIR/settings.json" ]]; then
	backup_path "$AGENT_DIR/settings.json"
	cp -a "$AGENT_DIR/settings.json" "$stage_dir/settings.json"
	node - "$stage_dir/settings.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
if (Array.isArray(settings.packages)) {
	settings.packages = settings.packages.filter((pkg) => pkg !== "npm:@ollama/pi-web-search");
}
fs.writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
NODE
fi

replace_path "$stage_dir/guardrail.ts" "$AGENT_DIR/extensions/guardrail.ts"
replace_path "$stage_dir/custom-header.ts" "$AGENT_DIR/extensions/custom-header.ts"
for src in "$stage_dir"/*/; do
	[[ -d "$src" ]] || continue
	name=$(basename "$src")
	case "$name" in skills-*|agents-*|prompts-*) continue ;; esac
	replace_path "$src" "$AGENT_DIR/extensions/$name"
done
for src in "$stage_dir"/skills-*; do
	base=${src##*/}; replace_path "$src" "$AGENT_DIR/skills/${base#skills-}"
done
for src in "$stage_dir"/agents-*; do
	base=${src##*/}; replace_path "$src" "$AGENT_DIR/agents/${base#agents-}"
done
for src in "$stage_dir"/prompts-*; do
	base=${src##*/}; replace_path "$src" "$AGENT_DIR/prompts/${base#prompts-}"
done
if [[ -f "$stage_dir/settings.json" ]]; then replace_path "$stage_dir/settings.json" "$AGENT_DIR/settings.json"; fi

node - "$backup_dir" "$backup_list" <<'NODE'
const fs = require("fs");
const [backupDir, listPath] = process.argv.slice(2);
const paths = fs.readFileSync(listPath, "utf8").split("\n").filter(Boolean);
fs.writeFileSync(`${backupDir}/manifest.json`, `${JSON.stringify({ createdAt: new Date().toISOString(), paths }, null, 2)}\n`);
NODE

if [[ "$WITH_BROWSER" == true ]]; then
	(cd "$AGENT_DIR/extensions/browser" && npx --yes playwright@1.49.0 install chromium)
fi

echo "installed bundled pi resources into $AGENT_DIR"
echo "backup: $backup_dir"
if [[ ! -f "$AGENT_DIR/extensions/web-search/auth.json" ]]; then
	echo "hint: create $AGENT_DIR/extensions/web-search/auth.json before using web_search"
fi
