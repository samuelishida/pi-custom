# Pi Custom Build — Stock pi + Pre-installed Extensions, Skills & Prompts

## Context

Build a personalized pi agent distribution that ships, out of the box, with the
user's local `guardrail.ts` extension, the `hawk-skills-md` skill set, feynman's
`autoresearch` + `deep-research` skills (and their prompt templates), and a
curated set of pi-config / standalone extensions — all on top of **stock pi**,
with **no core patch**. The user's locked decisions:

1. **Mechanism**: stock pi base; "just pre install those extensions + custom
   feynman structured skills + hawk-md skills". No core patch — pi core stays
   solid.
2. **Web tools**: use **pi-config's Web Tools** (`web-fetch` + `web-search`).
   `pi-web-access` is **dropped**.
3. **Fork base**: **latest** = pi **v0.85.1** (npm + git tag confirmed).
4. **Scope**: frozen 12-extension inclusion list; see *Assumptions and answers
   from code*.
5. **Artifact**: a **new GitHub repo** created in the `PiCode` workspace,
   **forked from `earendil-works/pi`**, using `../gh_token.txt` for auth.

The distribution is a fork of pi that carries a `bundled/` tree of resources plus
a **pre-install script** that copies those resources into the user's
`~/.pi/agent/{extensions,skills,prompts}/` and installs each extension's runtime
dependencies. Because pi has **no self-discovery of its own package resources**,
"built in" is realized as a deterministic pre-install step, not a runtime hook.
Pi itself selects an alternate agent directory only through
`PI_CODING_AGENT_DIR`; installer and verification use that name. The installer
may accept `PI_AGENT_DIR` as a documented compatibility alias, but never uses it
for pi process isolation.

## Architectural decisions

- **Decision: stock pi fork + vendored `bundled/` + pre-install script (no core
  patch).** Rationale: pi discovers extensions/skills/prompts only from
  `~/.pi/agent/…`, `.pi/…`, and `pi install`-ed packages — never from its own
  package dir. Pre-installing into `~/.pi/agent/` is the only way to make these
  "default" without touching core. Alternatives rejected: (a) patching pi core
  to self-register bundled resources (violates "keep pi core solid"); (b) pure
  `pi install npm:…` at setup (no vendoring drift, but `pi-interactive-subagents`
  is git-only and the user explicitly wants "built in / pre-install").
- **Decision: vendor third-party sources into `bundled/` with a
  `bundle-manifest.json` pinning every source version/commit/SHA and dependency
  tarball integrity.** Rationale: deterministic, auditable, reproducible,
  offline installs; manifest is supply-chain record. Vendored tree includes
  `pi-interactive-subagents` and npm package tarballs/lockfiles. Alternatives
  rejected: install-from-network at setup time (non-reproducible, breaks offline).
- **Decision: every extension is installed as a direct child of
  `agent/extensions/`, never under `extensions/node_modules/`.** Pi discovers
  only direct files or immediate directories with `index.*` or a
  `pi.extensions` manifest. Each vendored package therefore keeps its own
  `package.json`, declared entry point, lockfile, and local `node_modules`.
- **Decision: build a standalone binary side-by-side (`pi-custom`), not
  replacing `~/.local/bin/pi`.** Rationale: safer rollback; stock `pi` remains
  available.
- **Decision: feynman ships as skills + adapted prompt templates only (no
  feynman extension, no feynman tools).** Source templates use `fetch_content`,
  while pi-config Web Tools registers `web_fetch`; vendored templates replace
  that literal and use Web Fetch's verified argument schema. `web_search`
  remains unchanged. Record source SHA and adaptation diff in manifest/README.

## Assumptions and answers from code

- **Global extension discovery**: `~/.pi/agent/extensions/*.ts` and
  `~/.pi/agent/extensions/*/index.ts`. Source: pi `loader.ts` (fetched in prior
  session) | code.
- **Global skills discovery**: `~/.pi/agent/skills/` (recursive, subdir
  `SKILL.md`). Source: `dist/core/skills.js:330-334`
  (`join(resolvedAgentDir, "skills")`) | code.
- **Global prompt discovery**: `~/.pi/agent/prompts/*.md` (filename = command
  name). Source: pi docs/packages.md + prompt loader | code.
- **Agent directory override**: pi v0.85.1 reads `PI_CODING_AGENT_DIR`, not
  `PI_AGENT_DIR`. Source: `packages/coding-agent/src/config.ts` | code.
- **Import compatibility**: loader `VIRTUAL_MODULES` (binary) + jiti `_aliases`
  (node) map `@mariozechner/pi-*` → bundled earendil packages, plus
  `typebox`/`@sinclair/typebox`. All pi-config extensions import only these +
  node builtins + their own listed deps → all load. Source: pi `loader.ts` +
  per-extension import audit | code.
- **pi latest = v0.85.1**. Source: `npm view @earendil-works/pi-coding-agent
  version` = 0.85.1; git tag `v0.85.1` = `d981de1229ef899957bbe968bc8dcda02a21f477`
  | code.
- **Vendored extension deps** (exact, from each `package.json`):
  - `web-fetch`: `@mozilla/readability ^0.5.0`, `linkedom ^0.16.0`,
    `turndown ^7.2.0`, `unpdf ^1.4.0`.
  - `browser`: `playwright-core ^1.49.0`.
  - `bash-guard`: `shell-quote ^1.8.3`.
  - `web-search`: none (node:fs/path only).
  - `ask-user-question`, `custom-header`, `prompt-snippets`: none (pi + typebox
    only).
  Source: `/tmp/pi-config/extensions/*/package.json` | code.
- **Standalone extensions (npm)**: `pi-undo-redo@0.1.1` (zero deps),
  `pi-dictate@1.0.6` (dep `openai ^6.44.0`), `pi-observational-memory@3.0.4`
  (peers = 4 pi packages `"*"`). Source: `npm view` | code.
- **`pi-interactive-subagents` is NOT on npm** (404) → vendor source from
  `amosblomqvist/pi-interactive-subagents` @ `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`
  (tmux-based), including lockfile and SHA-256 tree digest. Source: `npm view`
  404 + repo | code.
- **feynman sources**: `skills/autoresearch/SKILL.md`, `skills/deep-research/
  SKILL.md`, `prompts/autoresearch.md`, `prompts/deepresearch.md` from
  `~/.local/share/feynman/feynman-0.3.46-linux-x64/app/`. Source: local feynman
  app | code.
- **hawk-skills-md sources**: 17 skills + 7 agents at
  `/media/smk/.../Code/hawk-skills-md/` @ `0b1de1405c52755f01c1f7ffa67a9a8a63a1b7ab`.
  Source: local checkout | code.
- **`guardrail.ts` source**: `~/.pi/agent/extensions/guardrail.ts` (44873 B,
  pure extension-API consumer). Source: local pi config | code.
- **`web_search` tool collision**: user's `~/.pi/agent/settings.json` packages
  include `npm:@ollama/pi-web-search`, which also registers `web_search`.
  Pre-install must drop it. Source: `~/.pi/agent/settings.json` | code.
- **pi-config clone**: `/tmp/pi-config` @ `f82da563ab05d66729492d64c7ed4e96db3663f3`.
  Source: local clone | code.
- **`gh_token.txt`**: `../gh_token.txt` exists (40 B, mode 600). Used only for
  GitHub push auth; never committed, never printed. Source: filesystem | code.
- **Decision: hawk skills reference Claude Code `Agent(subagent_type="audit-*")`
  subagents that pi has no equivalent for; ship as-is with dead refs.**
  Source: hawk skill bodies | default (accepted).
- **Frozen inclusion list (12 extensions):** `guardrail`, `ask-user-question`,
  `custom-header`, `prompt-snippets`, `bash-guard`, `browser`, `web-fetch`,
  `web-search`, `pi-undo-redo`, `pi-dictate`, `pi-observational-memory`, and
  `pi-interactive-subagents`. Pi-config's four extra skills
  (`analyze-sessions`, `pdf-reader`, `web-debug`, `youtube-transcript`) are out
  of scope. Source: review resolution.

## Risks accepted

- **Version drift** (extensions built for 0.84.x run on 0.85.1 base): mitigate
  with `npm run check` + a load test in Inc 1/Inc 5; accept; revisit if a
  specific extension fails to load.
- **`web_search` tool collision**: mitigate by dropping `npm:@ollama/pi-web-search`
  from settings packages in the pre-install script (with backup); accept.
- **Supply chain** (vendored third-party code): mitigate with
  `bundle-manifest.json` pinning versions/commits, SHA-256 digests, package
  integrities, and lockfiles; offline install rejects incomplete cache.
- **playwright-core + chromium** (~150 MB+, browser extension): mitigate by
  making `npx playwright install chromium` an **optional, flag-gated** step;
  accept.
- **guardrail constants tuned for the user's Ollama quant model** (stall
  watchdog vs slow local inference): accept; monitor via Inc 5 E2E.
- **`pi-interactive-subagents` tmux dependency**: requires `tmux` at runtime;
  accept (documented in README).
- **`pi-dictate` mic/whisper + `openai` dep**: requires a working mic + API key;
  accept (documented).
- **Credentialed workflow validation**: needs selected-model auth plus
  `web-search/auth.json`; test only in explicit credentialed integration lane.

## Increment DAG

- Inc 1 — Fork pi v0.85.1 into nonempty workspace, verify build (M) — **done** — depends on: none — unblocks: 2, 4
- Inc 2 — Vendor `bundled/` resources + `bundle-manifest.json` (M) — **done** — depends on: 1 — unblocks: 3
- Inc 3 — `scripts/preinstall-bundle.sh` (M) — **done** — depends on: 2 — unblocks: 5
- Inc 4 — Build standalone binary, install side-by-side (M) — depends on: 1 — unblocks: 5
- Inc 5 — E2E verification (M) — depends on: 3, 4 — unblocks: 6
- Inc 6 — Repo README (S) — depends on: 5 — unblocks: none

## Increments

### Inc 1 — Fork pi v0.85.1 → new GitHub repo, verify build (M)
**Depends on:** none
**Unblocks:** 2, 4
**Status:** done
**Done criteria:** new GitHub fork exists at fixed name `pi-custom`; working
tree is pi v0.85.1 while retaining `.plans/`; and
`npm install --ignore-scripts && npm run build && npm run check` all pass in it.

#### Files to touch
##### (repo root) — forked pi v0.85.1
- What changes: create GitHub fork through GitHub fork API, clone fork into
  staging dir, check out `v0.85.1`, then copy staging contents including `.git`
  into workspace without replacing `.plans/`. Set `origin` to fork and
  `upstream` to `earendil-works/pi`.
- Integration points: GitHub fork API + `git push`.
- Error paths: GitHub API failure (bad token / rate limit) → abort, do not push;
  build/check failure → stop, do not proceed to Inc 2.
##### .gitignore
- What changes: add `gh_token.txt`, `out/`, `node_modules/`, `*.log` so the token
  and build artifacts are never committed.
- Error paths: none.

#### Edge cases
- Workspace `PiCode` is not empty: it contains this plan. Staging-copy flow must
  preserve `.plans/` and fail if other unexpected workspace entries exist.
- `gh_token.txt` lives at `../gh_token.txt` (outside the repo) — never copied in.
- Repo name is `pi-custom`; if it exists, abort rather than silently selecting a
  different remote.

#### Verification
- Run: `npm install --ignore-scripts && npm run build && npm run check`
- Tests to add/update: none (pi's own `npm run check`).
- Done: new remote repo reachable; `git log -1` shows v0.85.1 content; check
  passes clean.

### Inc 2 — Vendor `bundled/` resources + `bundle-manifest.json` (M)
**Depends on:** 1
**Unblocks:** 3
**Status:** done
**Done criteria:** `bundled/` contains all in-scope extensions, skills, agents,
and prompts; `bundle-manifest.json` lists every source with version/commit/SHA.

#### Files to touch
##### bundled/extensions/guardrail.ts
- What changes: copy from `~/.pi/agent/extensions/guardrail.ts`.
- Error paths: source missing → abort.
##### bundled/extensions/{ask-user-question.ts, custom-header.ts}
- What changes: copy from `/tmp/pi-config/extensions/`.
##### bundled/extensions/{bash-guard,browser,web-fetch,web-search,prompt-snippets}/
- What changes: copy each extension dir (incl. its `package.json`) from
  `/tmp/pi-config/extensions/`. `web-search` includes `auth.example.json` (the
  real `auth.json` is never copied).
- Error paths: missing dir → abort.
##### bundled/extensions/{pi-undo-redo, pi-dictate, pi-observational-memory,pi-interactive-subagents}
- What changes: vendor each complete extension package as a direct-installable
  directory, including `package.json`, pi entry manifest or adapter, lockfile,
  and cached package tarballs required by `npm ci --offline`. Do not install
  them under shared `extensions/node_modules/`.
##### bundled/skills/ (19 skills)
- What changes: 17 hawk skills (from `hawk-skills-md/skills/`) + feynman
  `autoresearch/` + `deep-research/` (from feynman app `skills/`).
##### bundled/agents/ (7 agents)
- What changes: copy the 7 hawk `agents/*.md`.
##### bundled/prompts/{autoresearch.md, deepresearch.md}
- What changes: copy feynman prompt templates.
##### bundle-manifest.json
- What changes: new file. Shape:
  ```json
  {
    "pi": { "version": "0.85.1", "tag": "v0.85.1", "commit": "d981de1229ef899957bbe968bc8dcda02a21f477" },
    "sources": {
      "guardrail": { "path": "~/.pi/agent/extensions/guardrail.ts", "bytes": 44873 },
      "pi-config": { "repo": "amosblomqvist/pi-config", "commit": "f82da563ab05d66729492d64c7ed4e96db3663f3" },
      "hawk-skills-md": { "repo": "samuelishida/hawk-skills-md", "commit": "0b1de1405c52755f01c1f7ffa67a9a8a63a1b7ab" },
      "feynman": { "app": "feynman-0.3.46-linux-x64" },
      "npm": { "pi-undo-redo": { "version": "0.1.1", "integrity": "<npm-integrity>", "sha256": "<tarball-sha256>" }, "pi-dictate": { "version": "1.0.6", "integrity": "<npm-integrity>", "sha256": "<tarball-sha256>" }, "pi-observational-memory": { "version": "3.0.4", "integrity": "<npm-integrity>", "sha256": "<tarball-sha256>" } },
      "git": { "pi-interactive-subagents": { "repo": "amosblomqvist/pi-interactive-subagents", "commit": "c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7", "sha256": "<tree-sha256>" } }
    }
  }
  ```
- Error paths: manifest must be valid JSON; the pre-install script validates it.

#### Edge cases
- `web-search/auth.json` (real credentials) must NOT be copied — only
  `auth.example.json`.
- feynman skills reference feynman tools conditionally; do not copy feynman's
  `extensions/` or other ~30 skills.
- hawk skills/agents are markdown; no build step.

#### Verification
- Run: `find bundled -type f | sort` and `node -e "JSON.parse(require('fs').readFileSync('bundle-manifest.json'))"`.
- Tests to add/update: none.
- Done: all expected paths present; manifest parses; no `auth.json` present.

### Inc 3 — `scripts/preinstall-bundle.sh` (M)
**Depends on:** 2
**Unblocks:** 5
**Status:** done
**Done criteria:** running the script idempotently populates a target
`~/.pi/agent/` with all extensions (deps installed), skills, prompts, backs up
existing files, and removes the colliding package — with no errors.

#### Files to touch
##### scripts/preinstall-bundle.sh
- What changes: new bash script. Steps (idempotent, `set -euo pipefail`):
  1. Resolve `AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"`;
     warn when compatibility alias is used; create `extensions/`, `skills/`,
     `prompts/`.
  2. **Backup**: for each file/dir about to be overwritten, copy to
     `$AGENT_DIR/.backup-<timestamp>/` (never delete originals).
  3. Copy `bundled/extensions/guardrail.ts`, `ask-user-question.ts`,
     `custom-header.ts` → `$AGENT_DIR/extensions/`.
  4. Copy every bundled extension directory to direct child
     `$AGENT_DIR/extensions/<name>/`; validate each has `index.*` or valid
     `pi.extensions` entry before dependency install.
  5. Verify each directory and cached tarball SHA against manifest, then run
     `npm ci --omit=dev --offline` inside each extension with dependencies. No
     registry fetch or shared extension `node_modules` tree.
  6. Copy vendored `pi-interactive-subagents`; never clone at install time.
  7. Copy `bundled/skills/*` → `$AGENT_DIR/skills/` (19 skills).
  8. Copy `bundled/prompts/*.md` → `$AGENT_DIR/prompts/`.
  9. **Settings edit**: if `settings.json` exists and `packages` contains
     `npm:@ollama/pi-web-search`, remove it (back up `settings.json` first).
  10. Optional (flag `--with-browser`): `npx playwright install chromium`.
- Data shapes: reads `bundle-manifest.json` for pinned versions; writes nothing
  to the repo.
- Integration points: npm, git, `npx playwright`, user's `~/.pi/agent/`.
- Error paths: any `npm install` failure → non-zero exit, report which extension;
  git clone failure → non-zero; settings edit only touches the one array entry.
##### .gitignore
- What changes: ensure `out/`, `node_modules/`, `gh_token.txt`, `*.log` ignored
  (already added in Inc 1; no-op if present).

#### Edge cases
- Re-run: copy via staged temporary sibling then atomic rename. Backup manifest
  records replaced paths; no stale managed files survive. `npm ci --offline`
  uses lockfile/cache; no git clone occurs.
- `web-search` needs `auth.json` at runtime; script copies only
  `auth.example.json` and prints a hint to create `auth.json`.
- Existing `guardrail.ts` in `~/.pi/agent/extensions/` → backed up, then
  overwritten by vendored copy. Restore command reads backup manifest and
  restores originals plus `settings.json` atomically.
- `pi-observational-memory` peer deps (4 pi packages `"*"`) resolve against the
  installed pi; if running from source, peers are satisfied by the workspace.

#### Verification
- Run: `PI_CODING_AGENT_DIR=/tmp/pi-e2e bash scripts/preinstall-bundle.sh`.
- Tests to add/update: none.
- Done: `/tmp/pi-e2e/{extensions,skills,prompts}` fully populated; every
  extension is direct child with discoverable entry and expected local deps;
  settings collision absent when settings exists; second run exits 0 with no
  managed-tree diff.

### Inc 4 — Build standalone binary, install side-by-side (M)
**Depends on:** 1
**Unblocks:** 5
**Done criteria:** a standalone `pi-custom` binary builds for linux-x64 and runs
`--version` side-by-side with the existing `pi`.

#### Files to touch
##### scripts/build-custom.sh
- What changes: new wrapper that runs
  `./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out
  "$PWD/out"`, verifies `$PWD/out/linux-x64/pi`, then atomically installs that
  exact executable to `~/.local/bin/pi-custom`
  (does **not** touch `~/.local/bin/pi`).
- Integration points: pi's `scripts/build-binaries.sh`.
- Error paths: build failure → non-zero, do not copy; target exists → back up
  before overwrite.

#### Edge cases
- `--offline-model-data` keeps model data embedded (no network at runtime).
- Binary is side-by-side; the stock `pi` remains untouched.

#### Verification
- Run: `bash scripts/build-custom.sh && ~/.local/bin/pi-custom --version`.
- Tests to add/update: none.
- Done: `pi-custom --version` prints 0.85.1; `~/.local/bin/pi` still works.

### Inc 5 — E2E verification (M)
**Depends on:** 3, 4
**Unblocks:** 6
**Done criteria:** structural lane using fresh `PI_CODING_AGENT_DIR` loads every
extension without import errors, lists all 19 skills, and registers `web_search`
plus `web_fetch`. Separate credentialed integration lane proves slash workflows.

#### Files to touch
##### scripts/e2e-check.sh
- What changes: structural script that (a) runs pre-install into throwaway
  `PI_CODING_AGENT_DIR`, (b) launches extension-discovery harness against same
  directory without LLM/provider calls, (c) asserts no extension load errors,
  all 19 skills, and exactly pi-config `web_search` + `web_fetch`.
##### scripts/e2e-integration-check.sh
- What changes: opt-in credentialed lane. Requires explicit test model config,
  auth, and `web-search/auth.json` supplied outside repo; runs slash workflows
  and verifies actual tool calls. Refuses to run when inputs are absent.
- Integration points: `pi-custom`, pre-install script.
- Error paths: any load error / missing skill / missing tool → non-zero with the
  offending name.

#### Edge cases
- Guardrail is active (its compaction/watchdog hooks register) — confirm no
  startup throw.
- `web_search` must resolve to pi-config implementation (collision gone);
  `web_fetch` is expected tool name.
- Browser extension loads but chromium is optional — a missing chromium must not
  fail the load (only the tool call would).

#### Verification
- Run: `bash scripts/e2e-check.sh`; optional `bash scripts/e2e-integration-check.sh`.
- Tests to add/update: none.
- Done: structural script exits 0 without provider credentials; integration
  script, when explicit credentials supplied, proves slash workflows and tool
  calls without exposing secrets.

### Inc 6 — Repo README (S)
**Depends on:** 5
**Unblocks:** none
**Done criteria:** the repo README documents what is bundled, how to install,
uninstall, and upgrade, and the optional browser/dictate/interactive-subagents
requirements.

#### Files to touch
##### README.md
- What changes: new README. Sections: what's bundled (extensions/skills/prompts
  with sources from `bundle-manifest.json`), install (`preinstall-bundle.sh`),
  optional `--with-browser`, uninstall (restore from `.backup-<timestamp>/`),
  upgrade (re-fork/rebase at new pi tag, refresh vendored locks/hashes, re-run
  pre-install), runtime requirements (tmux for interactive-subagents, mic+key
  for dictate, chromium for browser, `web-search/auth.json`), backup
  manifest/restore, direct extension layout, and offline-cache requirement.
- Error paths: none.

#### Edge cases
- Must not reference `gh_token.txt` or print secrets.
- Must state that hawk `audit-*` subagent refs are inert in pi (no equivalent).

#### Verification
- Run: `npx markdownlint README.md` (or visual review).
- Tests to add/update: none.
- Done: README present, accurate, no secrets.

## Cross-cutting verification

- After Inc 3 + Inc 4: run structural `scripts/e2e-check.sh` using
  `PI_CODING_AGENT_DIR`; this is required no-secret gate.
- After Inc 5: run opt-in credentialed lane and manually walk real session with
  `pi-custom` — confirm
  `guardrail` compaction is visible, `/autoresearch` and `/deepresearch` produce
  output using `web_search`/`web_fetch`, and `web_search` is pi-config's
  (not `@ollama/pi-web-search`).
- Rollback check: confirm `~/.pi/agent/.backup-<timestamp>/` restores the
  pre-install state (including the original `settings.json` and `guardrail.ts`).
- Secret check: scan `bundled/` and repo for `auth.json`, `.env`, token patterns,
  and `gh_token`; only allowed `auth.example.json` remains. `git status` shows
  `gh_token.txt` ignored.

## Standards / common-mistakes referenced

- No `.agents/standards/` exists in this (empty) workspace. The de facto
  standards are the `hawk-skills-md` skill set (this plan was produced under
  `plan-large`), so:
  - `plan-large/SKILL.md` — increment DAG discipline, deterministic review,
    big-output discipline. Applies to: all increments.
  - `code-audit/SKILL.md` — anti-pattern checks. Applies to: Inc 3/4/5 scripts.
  - `fix-bug/SKILL.md` — hypothesis-first debugging. Applies to: Inc 5 failures.

## Resolved scope

- Exact extension inclusion list is frozen at 12 in *Assumptions and answers
  from code*.
- Binary remains side-by-side as `~/.local/bin/pi-custom`; never replace
  `~/.local/bin/pi`.
- Pi-config's four extra skills remain out of scope.

## Out of scope

- **No pi core patch** — pi core stays stock v0.85.1.
- **No feynman extension or feynman tools** — only the 2 skills + 2 prompt
  templates.
- **No `pi-web-access`** — replaced by pi-config Web Tools.
- **No feynman's other ~30 skills** (alphafold2, boltz, etc.).
- **No pi-config's 4 extra skills**.
- **No hawk `audit-*` subagent runtime** — hawk skills ship with inert
  Claude-Code-style subagent refs (pi has no equivalent).
- **No changes to the user's Ollama model config** (`smtek/Qwen3.8-27B:latest`).
