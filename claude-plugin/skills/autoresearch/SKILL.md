---
name: autoresearch
description: Bounded research experiment loop that tries hypotheses, measures benchmark evidence, keeps what works, and records what fails. Use when the user asks to optimize a research metric, run an experiment loop, improve model/retrieval/evaluation performance iteratively, or benchmark a research hypothesis.
---

# Autoresearch

Run a bounded, foreground research experiment loop using the tools visible in
the current session. This skill is tool-agnostic: it works in Claude Code, pi,
and any agent that reads Agent Skills. Use whatever search, fetch, shell, and
subagent tools the host agent exposes; never assume a specific tool name exists.

## Tool discipline

- Use the host agent's search tool (e.g. `web_search`, `WebSearch`, `Grep`) for
  web or code search. Do not invent tool names.
- Use the host agent's fetch/read tool (e.g. `web_fetch`, `WebFetch`, `Read`)
  to inspect URLs or files.
- Use the host agent's shell tool (e.g. `Bash`) to run the benchmark command.
- Use the host agent's subagent tool (e.g. `subagent`, `Task`, `Explore`) to
  delegate to the `researcher`, `verifier`, and `reviewer` agents when available.
- If a capability is missing, record it as blocked and continue in degraded mode.
  Never fabricate benchmark results or evidence.

## Session files

Track the loop in three session files:
- `autoresearch.md` — narrative log of hypotheses, decisions, and outcomes
- `autoresearch.sh` — the benchmark command(s) used
- `autoresearch.jsonl` — machine-readable per-iteration records

## Workflow

### Step 1: Gather

If `autoresearch.md` and `autoresearch.jsonl` already exist, ask the user
whether to resume or start fresh. If `CHANGELOG.md` exists, read the most recent
relevant entries before resuming.

Otherwise, collect from the user before doing anything else:
- What to optimize (model accuracy, retrieval quality, training loss, ablation
  score, evaluation latency, etc.)
- The benchmark command to run
- The metric name, unit, and direction (lower/higher is better)
- Files in scope for changes
- Maximum number of iterations (default: 20)

### Step 2: Environment

Ask the user where to run:
- **Local** — run in the current working directory
- **New git branch** — create a branch so main stays clean
- **Virtual environment** — create an isolated venv/conda env first
- **Docker** — run experiment code inside an isolated Docker container
- **Remote/GPU** — run on a remote or GPU host if the host agent supports it

Do not proceed without a clear answer.

### Step 3: Confirm

Present the full plan to the user before starting:

```
Optimization target: [metric] ([direction])
Benchmark command:   [command]
Files in scope:      [files]
Environment:         [chosen environment]
Max iterations:      [N]
```

Ask the user to confirm. Do not start the loop without explicit approval.

### Step 4: Run

Initialize the session: create `autoresearch.md`, `autoresearch.sh`,
`autoresearch.jsonl`, run the baseline, and start looping.

Each iteration: edit -> run the benchmark -> log the benchmark result, evidence,
and decision -> compare against the baseline -> keep the change, revert it, or
record the failed hypothesis -> repeat. Do not stop unless interrupted or
`maxIterations` is reached.

After the baseline and after meaningful iteration milestones, append a concise
entry to `CHANGELOG.md` summarizing what changed, what metric result was
observed, what failed, and the next step.

### Step 5: Evidence handoff

After the loop reaches its stop condition, derive a short lowercase hyphenated
slug from the optimization target. If a subagent tool is available, run the
`researcher` agent first to gather sources and benchmark context, then run
`verifier` against the draft, and finally run `reviewer` against the cited
artifact. Pass each agent a unique output path under `outputs/`; do not rely on
agent frontmatter to choose paths. If any agent or web capability is missing,
record `Verification: BLOCKED` and the exact missing capability instead of
claiming verification.

Write the final cited brief to `outputs/<slug>.md` and matching provenance to
`outputs/<slug>.provenance.md`. Include benchmark commands, raw evidence paths,
iteration decisions, source URLs, and unresolved checks. Verify both files exist
on disk before responding.

## Optional experiment tools

Use these only when they are visible in the current tool set:
- `init_experiment` — one-time session config (name, metric, unit, direction)
- `run_experiment` — run the benchmark command, capture output and wall-clock time
- `log_experiment` — record the benchmark result, evidence, and decision

Without those tools, run the benchmark through the available shell tooling and
record benchmark result, evidence, and decision in the session files.

## Subcommands

- `/autoresearch <text>` — start or resume the loop
- `/autoresearch off` — stop the loop, keep data
- `/autoresearch clear` — delete all state and start fresh
