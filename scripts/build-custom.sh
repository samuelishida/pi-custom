#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT_DIR="$ROOT_DIR/out"
TARGET_DIR="$HOME/.local/bin"
TARGET="$TARGET_DIR/pi-custom"
RUNTIME_PARENT="$HOME/.local/share"
RUNTIME_DIR="$RUNTIME_PARENT/pi-custom"

"$ROOT_DIR/scripts/build-binaries.sh" \
	--offline-model-data \
	--platform linux-x64 \
	--out "$OUT_DIR"

BINARY="$OUT_DIR/linux-x64/pi"
[[ -f "$BINARY" && -x "$BINARY" ]] || {
	echo "expected executable missing: $BINARY" >&2
	exit 1
}

mkdir -p "$TARGET_DIR"
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
	backup="$TARGET.backup-$(date -u +%Y%m%dT%H%M%S%N)"
	cp -a "$TARGET" "$backup"
	echo "backed up existing pi-custom to $backup"
fi

mkdir -p "$RUNTIME_PARENT"
if [[ -e "$RUNTIME_DIR" || -L "$RUNTIME_DIR" ]]; then
	runtime_backup="$RUNTIME_DIR.backup-$(date -u +%Y%m%dT%H%M%S%N)"
	mv "$RUNTIME_DIR" "$runtime_backup"
	echo "backed up existing pi-custom runtime to $runtime_backup"
fi

tmp_runtime=$(mktemp -d "$RUNTIME_PARENT/.pi-custom-runtime.XXXXXX")
tmp_target=$(mktemp "$TARGET_DIR/.pi-custom.XXXXXX")
rm -f "$tmp_target"
cleanup() { rm -f "$tmp_target"; rm -rf "$tmp_runtime"; }
trap cleanup EXIT
cp -a "$OUT_DIR/linux-x64/." "$tmp_runtime/"
chmod 0755 "$tmp_runtime/pi"
mv "$tmp_runtime" "$RUNTIME_DIR"
ln -s "$RUNTIME_DIR/pi" "$tmp_target"
mv -Tf "$tmp_target" "$TARGET"
trap - EXIT

echo "installed $TARGET"
