# pi-custom

Stock pi v0.85.1 distribution with pre-installed extensions, skills, agents, and
prompt templates. Pi core remains unmodified.

## What is bundled

- 15 extensions: guardrail, custom-header, prompt-snippets,
  browser, web-fetch, web-search, pi-undo-redo, pi-dictate,
  pi-observational-memory, pi-interactive-subagents, pi-diff, pi-mcp-adapter,
  pi-hermes-memory, pi-background-tasks, and pi-muselinn-harness.
- 19 skills: 17 hawk-skills-md skills plus Feynman's `autoresearch` and
  `deep-research` skills.
- Ten agent markdown files: seven hawk audit/planning agents plus Feynman's
  `researcher`, `verifier`, and `reviewer` profiles.
- The Feynman `researcher` profile intentionally overrides the generic
  researcher bundled inside `pi-interactive-subagents`; all callers keep the
  stable `researcher` name while using this bundle's evidence contract.
- `/autoresearch` and `/deepresearch` prompt templates.
- pi-config Web Tools: `web_search` and `web_fetch`.

Feynman templates were adapted from `fetch_content` to pi-config's
`web_fetch({url})`. Source commits, package integrities, tree hashes, and the
adaptation record live in [bundle-manifest.json](bundle-manifest.json).

## Usage tips

### Start a session

```bash
pi-custom                                    # interactive TUI session
pi-custom "Refactor this module"             # one-shot prompt
pi-custom --model openai/gpt-4o "..."        # pick a model for the run
```

Everything is a slash command with Tab completion. `pi` in the commands below
also works when your `~/.local/bin/pi-custom` symlink is on `PATH`.

### YOLO mode (muselinn permission chain)

`pi-muselinn-harness` ships an 18-level policy chain with three operational
modes: `auto`, `yolo`, `manual`. Sessions start in `manual` unless configured.

- **Switch for the current session:** `/mode yolo`
- **Persist as the startup mode** for fresh sessions:

  ```json
  {
    "defaultMode": "yolo"
  }
  ```

  in `~/.pi/agent/permissions.json` (global) or `.pi/permissions.json`
  (project). On conflict, the **global** file wins. A session with recorded
  `/mode` history restores its last-used mode; `defaultMode` only seeds fresh
  sessions.

> ⚠️ YOLO bypasses permission prompts, but destructive-command and
> sensitive-file guards (`rm -rf`, `git push --force`, `.env`, `id_rsa`,
> `*.key`) always ask and are never short-circuited. Use YOLO with care.

### Muselinn orchestration (sub-agents, plan, tasks)

The harness adds Kimi Code-style subsystems that stock pi lacks:

```text
/swarm on                                enable parallel sub-agents
/agent "<task>" <repo>                   spawn a focused sub-agent
/goal Refactor the auth module           set a goal with budget tracking
/todo init "Phase 1: scanner"            start a phased task plan
/plan                                    plan mode (read-only exploration + approval gate)
/pause                                   freeze everything; esc/enter/space/ctrl+c resumes
/steer                                    inject direction at runtime
/cron <5-field> <prompt>                 schedule background prompts
/tui style plain|boxed|compact           switch editor chrome anytime
```

Model-callable tools include `agent_swarm`, `agent`, `enter_plan_mode`,
`run_background`, `cron_create`, `todo_list`, and `ask_user_question` (tabbed
multi-question dialog).

### Hawk skills

19 skills ship bundled, including the 17 hawk-skills-md workflow skills
(`plan-small`, `plan-large`, `implement-plan`, `code-audit`, `fix-bug`,
`refactor`, `learn-system`, `compound`, `remove-code`, …). Invoke one directly
or let pi pick it from the description:

```text
/plan-large                            run plan skill as a slash command
/review-plan                           stress test a plan file
/implement-plan                        execute the .plans//plan.md incrementally
```

To reference a skill in a prompt so the model loads it, just name it —
each `SKILL.md` exposes a `description` pi matches against your intent.
Skills live under `~/.pi/agent/skills/`. Disable them with `--no-skills`.

### Change models

Set defaults in `~/.pi/agent/settings.json` (or `.pi/settings.json` for a
project):

- `defaultProvider`: `"ollama"`, `"anthropic"`, `"openai"`, `"google"`, …
- `defaultModel`: a model ID, e.g. `"smtek/Qwen3.8-27B-AD:IQ4_XS"`
- `defaultThinkingLevel`: `"off"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`,
  `"max"`

Interactively, `/model <pattern>` (Ctrl+S saves), `/thinking` (Ctrl+S saves),
and the CLI `--provider` / `--model` / `--models` flags (Ctrl+P cycles models).

### Launch pi with local Ollama models

Declare local models in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

For reasoning-capable models on OpenAI-compatible servers that do not
understand the `developer` role or `reasoning_effort`, add:

```json
"compat": {
  "supportsDeveloperRole": false,
  "supportsReasoningEffort": false
}
```

Then run `pi-custom --model ollama/qwen2.5-coder:7b`, or set
`defaultProvider`/`defaultModel` to it in `settings.json`. Ensure Ollama is
serving first (`ollama serve`). `ollama run qwen2.5-coder:7b` before starting
pi will pre-load the model.

## Install

Requirements: Node.js >=22.19, npm, and a populated bundled npm cache. Bun is
required only when building the standalone binary.

```bash
git clone --branch pi-custom-v0.85.1 https://github.com/samuelishida/pi-custom.git
cd pi-custom
bash scripts/preinstall-bundle.sh
bash scripts/build-custom.sh
```

Installer target defaults to `~/.pi/agent`. For isolated installs, set
`PI_CODING_AGENT_DIR` (the variable pi itself reads):

```bash
PI_CODING_AGENT_DIR=/tmp/pi-agent bash scripts/preinstall-bundle.sh
```

The compatibility alias `PI_AGENT_DIR` is accepted with a warning. Each
extension is installed as a direct child of `extensions/`; dependencies stay in
that extension's local `node_modules` and install from the committed offline
cache. Installer verifies bundle tree digests before staging, then removes
`npm:@ollama/pi-web-search` from `settings.json` after
backing it up, so pi-config owns `web_search`.

Chromium is optional:

```bash
bash scripts/preinstall-bundle.sh --with-browser
```

This downloads Chromium through the pinned Playwright CLI. Browser extension
loading does not require Chromium; browser calls do.

`pi-diff` is enabled by default. It wraps pi `write`/`edit` output with
syntax-highlighted unified or split diffs. Configure it with the bundled
`pi-diff.example.json` and `pi-diff.schema.json` references, or disable tools
using pi-diff's documented settings.

The autoresearch workflow uses `researcher`, `verifier`, and `reviewer` when
available. Its final cited brief belongs in `outputs/` with a matching
`.provenance.md` sidecar; session state is recorded in `autoresearch.md`,
`autoresearch.sh`, and `autoresearch.jsonl`.

`build-custom.sh` installs a runtime bundle under
`~/.local/share/pi-custom/` and a `~/.local/bin/pi-custom` symlink. Existing
`pi-custom` and runtime directories are timestamp-backed before replacement.
Stock `~/.local/bin/pi` is never replaced.

## Uninstall and restore

Installer creates `.backup-<UTC timestamp>/manifest.json` under the selected
agent directory. Stop pi, choose the backup from the install being removed, and
restore every path listed in its manifest to the agent directory. Remove the
managed bundle paths that did not exist before that backup (`extensions/` bundle
entries, bundled skills, bundled agents, and the two prompt files). Restore the
backed-up `settings.json` last. Keep backup until a normal pi session starts.

Binary rollback uses the timestamped files beside `~/.local/bin/pi-custom` and
`~/.local/share/pi-custom`; move the chosen backup back into place. Stock pi is
independent.

## Upgrade

Create a new branch from the next pi tag, refresh vendored sources and npm
tarballs, regenerate lockfiles/cache and manifest hashes, then rerun:

```bash
bash scripts/preinstall-bundle.sh
bash scripts/build-custom.sh
bash scripts/e2e-check.sh
```

Do not copy credentials into `bundled/`. `web-search` needs a user-created
`~/.pi/agent/extensions/web-search/auth.json`; only `auth.example.json` is
bundled. `pi-dictate` needs a microphone and OpenAI key. Interactive subagents
need `tmux`.

## Verification

Structural, no-credential verification:

```bash
bash scripts/e2e-check.sh
```

This checks direct extension discovery, expected skills/prompts, and
`web_search`/`web_fetch` registration without making an LLM request.

Credentialed workflow verification is opt-in and refuses missing credentials:

```bash
PI_CODING_AGENT_DIR="$HOME/.pi/agent" bash scripts/e2e-integration-check.sh
```

## Known scope boundary

hawk `audit-*` agent references target Claude Code's `Agent(...)` API. Pi has no
equivalent subagent runtime, so those references remain inert markdown. No
Feynman extension/tools, `pi-web-access`, or pi-config's four extra skills are
included.
