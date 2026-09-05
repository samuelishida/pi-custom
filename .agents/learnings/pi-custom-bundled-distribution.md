# Pi Custom Bundled Distribution

## Context

Built pi v0.85.1 fork with vendored extensions, skills, prompts, offline npm
cache, preinstall script, side-by-side Bun runtime, and structural E2E checks.

## Hardest decision

Keep pi core stock while making resources default: install every extension as a
direct child of `agent/extensions/`, adapt Feynman `fetch_content` to pi-config's
`web_fetch`, and ship Bun's adjacent runtime metadata so `pi-custom --version`
reports 0.85.1.

## Alternatives rejected

- Runtime package/network discovery — rejected for reproducibility and offline
  installation.
- `extensions/node_modules/` package placement — pi does not discover nested
  packages; direct `pi.extensions` manifests are required.
- Binary-only install — Bun binary reports `0.0.0` without adjacent
  `package.json` and runtime assets.

## Least confident

Credentialed `/autoresearch` and `/deepresearch` integration was not run because
model and web-search credentials were intentionally absent. Recheck actual tool
calls and browser Chromium behavior in a credentialed environment after upgrades.

## Reuse

Read before changing `bundled/`, `bundle-manifest.json`,
`scripts/preinstall-bundle.sh`, `scripts/build-custom.sh`, or E2E scripts.
