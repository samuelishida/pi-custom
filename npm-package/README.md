# research-skills

Tool-agnostic `autoresearch` and `deep-research` skills plus `researcher`,
`verifier`, and `reviewer` agents, adapted from Feynman's research workflows.

The skills and agents are **tool-agnostic**: they work in Claude Code, Codex,
pi, Cline, Roo Code, Windsurf, Cursor, Copilot, and any agent that reads the
[Agent Skills](https://agentskills.io) open standard. They never assume a
specific tool name exists — they map to whatever search, fetch, shell, and
subagent tools the host agent exposes.

---

## Table of contents

- [Install](#install)
- [What you get](#what-you-get)
- [How the skills work](#how-the-skills-work)
- [Usage](#usage)
- [Uninstall](#uninstall)
- [Source](#source)

---

## Install

Install the package globally, then run the installer:

```bash
npm install -g research-skills
research-install --all
```

`--all` installs into every supported tool it finds on disk. To target a
specific tool:

```bash
research-install --claude     # ~/.claude
research-install --codex      # ~/.codex
research-install --pi         # ~/.pi/agent
research-install --cline      # ~/.cline
research-install --roo        # ~/.roo
research-install --windsurf   # ~/.codeium/windsurf
research-install --cursor     # ~/.cursor
research-install --copilot    # ~/.github/prompts
```

The installer copies each skill into the tool's `skills/` directory and each
agent into the tool's `agents/` directory (tools that read agents). It is
idempotent: re-running it overwrites with a `.bak-<timestamp>` backup of any
existing file.

Preview what would be copied without touching anything:

```bash
research-install --all --dry-run
```

---

## What you get

### Skills

| Skill | Purpose |
|-------|---------|
| `autoresearch` | Bounded research experiment loop: try hypotheses, measure benchmark evidence, keep what works, record what fails. |
| `deep-research` | Thorough, source-heavy investigation producing a cited research brief with provenance tracking. |

### Agents

| Agent | Purpose |
|-------|---------|
| `researcher` | Evidence gathering across papers, web, repos, docs, and local artifacts. |
| `verifier` | Adds inline citations and verifies every source URL. |
| `reviewer` | Adversarial research critique and verification passes. |

---

## How the skills work

Both skills are **model-invoked**: the host agent loads them automatically when
a request matches their description, or you can invoke them directly by name.

### `autoresearch`

A bounded, foreground experiment loop for optimizing a research metric. It:

1. **Gathers** — asks what to optimize, the benchmark command, the metric
   (name, unit, direction), files in scope, and max iterations (default 20).
2. **Picks an environment** — local, a new git branch, a venv, Docker, or a
   remote/GPU host.
3. **Confirms the plan** — shows the full plan and waits for explicit approval.
4. **Runs the loop** — each iteration: edit → run the benchmark → log the
   result, evidence, and decision → compare against baseline → keep, revert, or
   record the failed hypothesis. Tracks state in `autoresearch.md`,
   `autoresearch.sh`, and `autoresearch.jsonl`.
5. **Hands off evidence** — when the loop stops, it derives a slug and (if a
   subagent tool is available) runs `researcher` → `verifier` → `reviewer`,
   writing a cited brief to `outputs/<slug>.md` with a
   `outputs/<slug>.provenance.md` sidecar.

### `deep-research`

A thorough, source-heavy investigation producing a cited brief. It:

1. **Plans** — writes `outputs/.plans/<slug>.md` with key questions, evidence
   needed, a scale decision, a task ledger, and verification/decision logs.
   Stops for explicit confirmation before gathering.
2. **Scales** — uses direct search for narrow questions; spawns `researcher`
   subagents only when decomposition clearly helps (comparisons, broad surveys,
   multi-domain topics).
3. **Gathers evidence** — searches and fetches sources, writing notes to
   `outputs/.drafts/`. Avoids crash-prone PDF parsing unless asked.
4. **Drafts** — writes the report itself, sweeping every claim against a source
   URL, research note, or artifact path.
5. **Cites** — runs the `verifier` agent to add inline citations and verify
   every URL.
6. **Reviews** — runs the `reviewer` agent for an adversarial verification pass,
   fixing FATAL issues before delivery.
7. **Delivers** — writes the final brief to `outputs/<slug>.md` (or
   `papers/<slug>.md`) plus a `.provenance.md` sidecar, and verifies on disk
   that all required artifacts exist.

### Tool-agnostic behavior

The skills and agents never hardcode a tool name. They instruct the model to
use whatever search, fetch, shell, and subagent tools the host agent exposes
(e.g. `WebSearch`/`web_search` for search, `WebFetch`/`web_fetch` for fetching,
`Read`/`Grep`/`Glob`/`Bash` for files and shell). If a capability is missing,
they record it as blocked and continue in degraded mode rather than fabricating
evidence.

---

## Usage

Invoke the skills by name in your agent:

- **Claude Code:** `/autoresearch <idea>`, `/deep-research <topic>`
- **Codex:** `@autoresearch <idea>`, `@deep-research <topic>`
- **pi:** `/autoresearch <idea>`, `/deepresearch <topic>`
- **Cline / Roo Code / Windsurf / Cursor / Copilot:** invoke the skill by name
  (`/autoresearch <idea>`, `/deep-research <topic>`) or trigger it with a plain
  language request — the host agent loads the matching skill automatically.

You can also just ask in plain language — the host agent loads the matching
skill automatically, e.g. "run a deep research investigation on X" or "optimize
the retrieval accuracy of this model".

---

## Uninstall

```bash
research-install --uninstall
```

Removes the installed skills and agents. Any files that were overwritten during
install remain as `.bak-<timestamp>` backups.

---

## Source

Adapted from Feynman's research workflows. See the parent `pi-custom` repo for
the full distribution.
