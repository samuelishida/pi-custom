# pi-custom research plugin

Tool-agnostic research skills and agents adapted from Feynman's `autoresearch`
and `deep-research` workflows, plus the hawk-skills audit agents.

This plugin works in **Claude Code** and any agent that reads the
[Agent Skills](https://agentskills.io) open standard. The skills and agents
never assume a specific tool name exists — they map to whatever search, fetch,
shell, and subagent tools the host agent exposes.

## Contents

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

## Install

From the marketplace:

```bash
/plugin marketplace add samuelishida/pi-custom
/plugin install research@pi-custom-research
```

Or load the plugin directory directly:

```bash
claude --plugin-dir ./claude-plugin
```

## Usage

- `/research:autoresearch <idea>` — start an optimization loop
- `/research:deep-research <topic>` — run a deep research investigation

## Source

Adapted from Feynman's research workflows and the hawk-skills-md agent set.
See the parent `pi-custom` repo for the full distribution.
