---
description: Bounded research experiment loop - try hypotheses, measure benchmark evidence, keep what works, discard what doesn't, repeat.
args: <idea>
section: Research Workflows
topLevelCli: true
---
## Tool Discipline (Read First)

Tool names are literal. Use only tools visible in the current tool set.

- Search with `web_search`; do not call `search_web`, `google_search`, `google:search`, `search_google`, or `WebSearch`.
- Fetch URLs with `web_fetch` using `{url: "https://…"}`; do not call `fetch_content`, bare `fetch`, `WebFetch`, or `read_url_content`.
- Use visible Feynman alpha tools such as `alpha_search` when present. For shell access, call `feynman alpha ...`; do not call the user's bare global `alpha` binary.
- To ask the user a question, write plain chat text and wait for the next user message. Do not call `ask_user_question`, `ask_user`, `ask_followup_question`, or `user_choice`.
- Do not use the tmux-based `subagent` tool. Run parallel research with the built-in pi background system instead: `bg_run` with a `pi -p "…"` child (`isAgent: true`), `bg_delegate` for read-only repo investigation, `fusion_research` / `fusion_investigate` for five-model research, or `run_background` / `agent` for built-in harness subagents.
- If `web_search` is unavailable (e.g. "Missing Google Custom Search credentials"), treat it as blocked: fall back to `web_fetch` on known URLs and record the capability as blocked.
- If a tool returns `Tool not found` or `Invalid URL`, do not retry the same invalid call. Map to a canonical visible tool and valid arguments, or record the capability as blocked.

Start an autoresearch optimization loop for: $@

This command runs a bounded foreground research experiment loop using the visible tools in this session.

## Step 1: Gather

If `autoresearch.md` and `autoresearch.jsonl` already exist, ask the user if they want to resume or start fresh.
If `CHANGELOG.md` exists, read the most recent relevant entries before resuming.

Otherwise, collect the following from the user before doing anything else:
- What to optimize (model accuracy, retrieval quality, training loss, ablation score, evaluation latency, etc.)
- The benchmark command to run
- The metric name, unit, and direction (lower/higher is better)
- Files in scope for changes
- Maximum number of iterations (default: 50)

## Step 2: Environment

Ask the user where to run:
- **Local** — run in the current working directory
- **New git branch** — create a branch so main stays clean
- **Virtual environment** — create an isolated venv/conda env first
- **Docker** — run experiment code inside an isolated Docker container
- **Modal** — run on Modal's serverless GPU infrastructure. Write Modal-decorated scripts and execute with `modal run`. Best for GPU-heavy benchmarks with no persistent state between iterations. Requires `modal` CLI.
- **RunPod** — provision a GPU pod via `runpodctl` and run iterations there over SSH. Best for experiments needing persistent state, large datasets, or SSH access between iterations. Requires `runpodctl` CLI.

Do not proceed without a clear answer.

## Step 3: Confirm

Present the full plan to the user before starting:

```
Optimization target: [metric] ([direction])
Benchmark command:   [command]
Files in scope:      [files]
Environment:         [chosen environment]
Max iterations:      [N]
```

Ask the user to confirm. Do not start the loop without explicit approval.

## Step 4: Run

Initialize the session: create `autoresearch.md`, `autoresearch.jsonl`, `autoresearch.sh`, run the baseline, and start looping.

Each iteration: edit -> run the benchmark -> log the benchmark result, evidence, and decision -> compare against the baseline -> keep the change, revert it, or record the failed hypothesis -> repeat. Do not stop unless interrupted or `maxIterations` is reached.
After the baseline and after meaningful iteration milestones, append a concise entry to `CHANGELOG.md` summarizing what changed, what metric result was observed, what failed, and the next step.

## Step 5: Evidence handoff

After the loop reaches its stop condition, derive a short lowercase hyphenated
slug from the optimization target. Gather sources and benchmark context with
the built-in pi background system (no tmux): launch `bg_run` children running
`pi -p "…"` (`isAgent: true`) for the researcher/verifier/reviewer roles, each
writing to a unique output path under `outputs/`; or use `fusion_research` for
targeted URL research. Do not rely on agent frontmatter to choose paths. If no
background agent or web capability is available, record `Verification: BLOCKED`
and the exact missing capability instead of claiming verification.

Write the final cited brief to `outputs/<slug>.md` and matching provenance to
`outputs/<slug>.provenance.md`. Include benchmark commands, raw evidence paths,
iteration decisions, source URLs, and unresolved checks. Verify both files
exist on disk before responding.

## Optional tools

Use these only when they are visible in the current tool set:

- `init_experiment` - one-time session config (name, metric, unit, direction)
- `run_experiment` - run the benchmark command, capture output and wall-clock time
- `log_experiment` - record the benchmark result, evidence, and decision in the autoresearch log

## Subcommands

- `/autoresearch <text>` — start or resume the loop
- `/autoresearch off` — stop the loop, keep data
- `/autoresearch clear` — delete all state and start fresh
