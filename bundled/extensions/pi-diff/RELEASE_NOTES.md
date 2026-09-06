# @heyhuynhgiabuu/pi-diff v0.8.1

## Fixed

- **Diff rendering and tool wrapping restored** — v0.8.0 declared the Pi SDK packages as peer dependencies, but pi's extension installer never installs peers, so the import failed inside `<project>/.pi/npm` installs and the extension silently degraded to plain built-in tools (one `[pi-diff] failed to load Pi SDK dependencies` line at startup). The Pi SDK packages are regular dependencies again, now at **0.84.2** to match current pi.

No rendering behavior changes otherwise: syntax-highlighted, word-level split/unified previews work exactly as before v0.8.0.

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-diff@0.8.1
```
