# pi-research-skills

Tool-agnostic `autoresearch` and `deep-research` skills plus `researcher`,
`verifier`, and `reviewer` agents, adapted from Feynman's research workflows.
Also bundles the hawk-skills audit agents.

The skills and agents are **tool-agnostic**: they work in Claude Code, Codex,
pi, and any agent that reads the [Agent Skills](https://agentskills.io) open
standard. They never assume a specific tool name exists — they map to whatever
search, fetch, shell, and subagent tools the host agent exposes.

## Install

```bash
npm install -g pi-research-skills
pi-research-install --all
```

Or install to a specific agent:

```bash
pi-research-install --claude   # ~/.claude
pi-research-install --codex    # ~/.codex
pi-research-install --pi       # ~/.pi/agent
```

Use `--dry-run` to preview, and `--uninstall` to remove.

## What you get

### Skills

- `autoresearch` — bounded research experiment loop: try hypotheses, measure
  benchmark evidence, keep what works, record what fails.
- `deep-research` — thorough, source-heavy investigation producing a cited
  research brief with provenance tracking.

### Agents

- `researcher` — evidence gathering across papers, web, repos, docs, and local
  artifacts.
- `verifier` — adds inline citations and verifies every source URL.
- `reviewer` — adversarial research critique and verification passes.
- `audit-architecture`, `audit-logic`, `audit-research`, `audit-security`,
  `audit-simplification`, `audit-triage`, `plan-reviewer` — hawk-skills code
  audit and plan-review context gatherers.

## Usage

- Claude Code: `/autoresearch <idea>`, `/deep-research <topic>`
- Codex: `@autoresearch <idea>`, `@deep-research <topic>`
- pi: `/autoresearch <idea>`, `/deepresearch <topic>`

## Source

Adapted from Feynman's research workflows and the hawk-skills-md agent set.
See the parent `pi-custom` repo for the full distribution.
