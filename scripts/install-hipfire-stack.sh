#!/usr/bin/env bash
# Install the hipfire server config, systemd unit, and pi model entries from
# bundled/hipfire/.
#
#   scripts/install-hipfire-stack.sh            # apply (backs up, idempotent)
#   scripts/install-hipfire-stack.sh --check    # report only, change nothing
#   scripts/install-hipfire-stack.sh --restart  # also restart hipfire
#
# config.toml and models.json carry the "per-turn budget must exceed the
# thinking cap" fix; see bundled/hipfire/README.md. Every target is backed up
# next to itself with a timestamp before being overwritten.
#
# Deliberately NOT wired into preinstall-bundle.sh: this touches a systemd unit
# and a service config, which is a heavier decision than installing pi
# extensions.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRC="$ROOT_DIR/bundled/hipfire"

HIPFIRE_DIR="${HIPFIRE_DIR:-$HOME/.hipfire}"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

MODE=apply
RESTART=false
for arg in "$@"; do
	case "$arg" in
	--check) MODE=check ;;
	--restart) RESTART=true ;;
	*)
		echo "usage: $0 [--check] [--restart]" >&2
		exit 2
		;;
	esac
done

[[ -d "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
changed=0

backup() {
	local target=$1
	[[ -e "$target" ]] || return 0
	cp -a "$target" "$target.bak-hipfire-$stamp"
	echo "      backup: $target.bak-hipfire-$stamp"
}

# ---- plain file copies ---------------------------------------------------
install_file() {
	local src=$1 dest=$2 label=$3
	if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
		printf 'ok    %-32s already current\n' "$label"
		return 0
	fi
	if [[ "$MODE" == check ]]; then
		printf 'DIFF  %-32s would update -> %s\n' "$label" "$dest"
		changed=1
		return 0
	fi
	mkdir -p "$(dirname "$dest")"
	backup "$dest"
	cp -a "$src" "$dest"
	printf 'wrote %-32s -> %s\n' "$label" "$dest"
	changed=1
}

install_file "$SRC/config.toml" "$HIPFIRE_DIR/config.toml" "hipfire config.toml"
install_file "$SRC/hipfire.service" "$SYSTEMD_DIR/hipfire.service" "hipfire.service"
# Per-model KV + speculation policy. This is the file that makes two models
# coexist: an Environment= pin in the unit wins over per-model config for EVERY
# model the unit serves, so the spec mechanism lives here instead (qwen3.8 =
# dflash, qwen3.6:35b-a3b-mq4r = mtp). Paths in it are machine-specific, hence
# the backup-before-overwrite in install_file.
install_file "$SRC/models.toml" "$HIPFIRE_DIR/models.toml" "hipfire models.toml"
# ExecStartPre: clears stale serve/daemon pid records (a zombie still answers
# kill -0, which makes `hipfire serve` die with "already running").
install_file "$SRC/serve-preclean.sh" "$HIPFIRE_DIR/bin/serve-preclean.sh" "serve-preclean.sh"
# Watchdog: retries failed starts, self-heals loader wedges, keeps the model
# resident. Units land in systemd; the timer is enabled below.
install_file "$SRC/hipfire-watchdog.sh" "$HIPFIRE_DIR/bin/hipfire-watchdog.sh" "hipfire-watchdog.sh"
install_file "$SRC/hipfire-watchdog.service" "$SYSTEMD_DIR/hipfire-watchdog.service" "hipfire-watchdog.service"
install_file "$SRC/hipfire-watchdog.timer" "$SYSTEMD_DIR/hipfire-watchdog.timer" "hipfire-watchdog.timer"

# ---- models.json: merge only the maxTokens fields ------------------------
# Never clobber the user's model catalog; it accumulates providers and edits.
# The node step prints a trailing "__CHANGED__" marker instead of encoding the
# result in its exit status, so `set -e` cannot swallow the report.
run_models_step() {
	local dest="$AGENT_DIR/models.json"
	local out
	out=$(node - "$SRC/models.json" "$dest" "$stamp" "$MODE" <<'NODE'
const fs = require("fs");
const [srcPath, destPath, stamp, mode] = process.argv.slice(2);
const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));
const check = mode === "check";
let changed = false;

if (!fs.existsSync(destPath)) {
  if (check) {
    console.log("DIFF  models.json                      would create from bundle");
    console.log("__CHANGED__");
    process.exit(0);
  }
  fs.mkdirSync(require("path").dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log(`wrote models.json                      -> ${destPath}`);
  console.log("__CHANGED__");
  process.exit(0);
}

const original = fs.readFileSync(destPath, "utf8");
const dest = JSON.parse(original);
const applied = [];

for (const [name, prov] of Object.entries(src.providers ?? {})) {
  const dprov = dest.providers?.[name];
  if (!dprov) continue; // never add back a provider the user removed
  for (const [i, model] of (prov.models ?? []).entries()) {
    if (model.maxTokens === undefined) continue;
    const dmodel = dprov.models?.[i];
    if (!dmodel || dmodel.maxTokens === model.maxTokens) continue;
    applied.push(
      `${name}/${model.id} maxTokens ${JSON.stringify(dmodel.maxTokens)} -> ${model.maxTokens}`,
    );
    if (!check) dmodel.maxTokens = model.maxTokens;
    changed = true;
  }
}

// Additive: a source model whose id is missing from an EXISTING destination
// provider is appended. Without this a restore silently drops entries (only
// maxTokens was merged, by index). Never re-adds a provider the user removed,
// and never deletes or reorders anything.
for (const [name, prov] of Object.entries(src.providers ?? {})) {
  const dprov = dest.providers?.[name];
  if (!dprov || !Array.isArray(dprov.models)) continue;
  for (const model of prov.models ?? []) {
    if (dprov.models.some((m) => m.id === model.id)) continue;
    applied.push(`${name}/${model.id} added (absent from catalogue)`);
    if (!check) dprov.models.push(model);
    changed = true;
  }
}

if (!changed) {
  console.log("ok    models.json                      already current");
  process.exit(0);
}
if (check) {
  for (const a of applied) console.log(`DIFF  models.json                      ${a}`);
  console.log("__CHANGED__");
  process.exit(0);
}

fs.writeFileSync(`${destPath}.bak-hipfire-${stamp}`, original);
fs.writeFileSync(destPath, JSON.stringify(dest, null, 2) + "\n");
console.log(`wrote models.json                      -> ${destPath}`);
for (const a of applied) console.log(`        ${a}`);
console.log("__CHANGED__");
NODE
	)
	printf '%s\n' "$out" | grep -v '^__CHANGED__$'
	if printf '%s\n' "$out" | grep -q '^__CHANGED__$'; then
		changed=1
	fi
}

chmod +x "$HIPFIRE_DIR/bin/serve-preclean.sh" "$HIPFIRE_DIR/bin/hipfire-watchdog.sh" 2>/dev/null || true

run_models_step

# ---- systemd -------------------------------------------------------------
if [[ "$MODE" == apply ]] && command -v systemctl >/dev/null 2>&1; then
	if systemctl --user daemon-reload 2>/dev/null; then
		echo "      systemd daemon-reload: ok"
	else
		echo "      systemd daemon-reload: skipped (no user session?)"
	fi
	if systemctl --user enable --now hipfire-watchdog.timer >/dev/null 2>&1; then
		echo "      hipfire-watchdog.timer: enabled"
	else
		echo "      hipfire-watchdog.timer: could not enable (no user session?)"
	fi
fi

echo
if [[ "$changed" -eq 0 ]]; then
	echo "everything already current"
	exit 0
fi

if [[ "$MODE" == check ]]; then
	echo "differences found (check mode: nothing was written)"
	exit 1
fi

echo "changes applied"
echo
echo "note: hipfire's config keys are Process-scope. Restart it to load"
echo "      config.toml, and run /reload in pi (or start a new session) so"
echo "      pi re-reads models.json:"
echo "        systemctl --user restart hipfire"

if [[ "$RESTART" == true && "$MODE" == apply ]]; then
	echo
	echo "restarting hipfire ..."
	systemctl --user restart hipfire
	systemctl --user is-active hipfire
fi
