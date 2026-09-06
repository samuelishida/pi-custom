# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Analyze hashline_read / hashline_edit tool calls in Pi session JSONL files.

Usage: uv run scripts/analyze-hashline-edits.py <session.jsonl> [more.jsonl ...]
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

HASHLINE_TOOLS = frozenset({"hashline_read", "hashline_edit"})


@dataclass
class Call:
	name: str
	failed: bool
	dry_run: bool


def analyze_file(path: Path) -> list[Call]:
	calls: list[tuple[str, Call]] = []
	results: dict[str, bool] = {}

	for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
		try:
			d = json.loads(line)
		except json.JSONDecodeError:
			continue
		if d.get("type") != "message":
			continue
		msg = d.get("message", {})
		role = msg.get("role")
		if role == "assistant":
			for c in msg.get("content", []):
				if c.get("type") != "toolCall" or c.get("name") not in HASHLINE_TOOLS:
					continue
				tid = c.get("id", "")
				args = c.get("arguments", {}) or {}
				dry = bool(args.get("dryRun")) if c.get("name") == "hashline_edit" else False
				calls.append((tid, Call(name=c["name"], failed=False, dry_run=dry)))
		elif role == "toolResult":
			tid = msg.get("toolCallId", "")
			results[tid] = bool(msg.get("isError"))

	out: list[Call] = []
	for tid, call in calls:
		out.append(Call(name=call.name, failed=results.get(tid, False), dry_run=call.dry_run))
	return out


def main() -> None:
	if len(sys.argv) < 2:
		print(__doc__.strip())
		sys.exit(1)

	paths: list[Path] = []
	for arg in sys.argv[1:]:
		p = Path(arg)
		paths.extend(sorted(p.glob("**/*.jsonl")) if p.is_dir() else [p])

	all_calls: list[Call] = []
	for p in paths:
		all_calls.extend(analyze_file(p))

	if not all_calls:
		print("No hashline_read / hashline_edit tool calls found.")
		return

	total = len(all_calls)
	fails = sum(1 for c in all_calls if c.failed)
	by_name: Counter[str] = Counter(c.name for c in all_calls)
	fail_by: Counter[str] = Counter(c.name for c in all_calls if c.failed)
	dry = sum(1 for c in all_calls if c.dry_run)

	print("=" * 56)
	print(f"Hashline tool analysis ({len(paths)} file(s))")
	print("=" * 56)
	print(f"Total calls: {total}")
	print(f"Failures: {fails} ({100 * fails / total:.1f}%)")
	print(f"hashline_edit dryRun: {dry}")
	for name, count in by_name.most_common():
		f = fail_by[name]
		print(f"  {name:<16} {count:>4}  fail: {f:>3} ({100 * f / count:.1f}%)")


if __name__ == "__main__":
	main()