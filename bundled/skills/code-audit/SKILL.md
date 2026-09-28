---
name: code-audit
description: Audit code with deterministic `rg` anti-pattern checks as the main path (logic, security, simplification, architecture), with optional audit-* subagents as context gatherers. Use when reviewing a diff, PR, or specific code. Supports report mode (default, stops for approval) and cleanup mode (auto-fix).
---

# Code Audit

The main path is deterministic: `rg` anti-pattern checks over the diff
capture, run first and always for every domain in scope. They own the
findings. The `audit-*` subagents are optional context gatherers —
they read the code and report raw observations back to the
orchestrator, which does the classification and the reply. None of
them knows the goal, the plan, or what the user is shipping.

That blindness is the point: a reviewer who knows the goal rationalizes
the code toward it; one who only has the diff and a narrow brief
evaluates the code on its own merits.

Briefs, anti-bias contracts, and output formats live in the agent
files (`audit-triage`, `audit-logic`, `audit-security`,
`audit-simplification`, `audit-research`, `audit-architecture`). This
skill orchestrates — it does not redefine them.

## Modes

- **Report** (default) — Produce a merged FIX/NOTE report and **stop**.
  No edits. Wait for human approval. Use when reviewing code you
  didn't write, reviewing a PR, or auditing a concern.
- **Cleanup** — Apply every FIX directly, then run the project's check
  command. Use as a post-implementation quality pass on your own code.

## Args

- `mode=report|cleanup` — default `report`.
- `tier=auto|light|standard|deep` — default `auto`. The `audit-triage`
  agent reads the diff and picks the tier; explicit values skip
  triage and use the static mapping below. Replaces the old
  `agents=full|light` knob (`agents=light` ≈ `tier=standard`,
  `agents=full` ≈ `tier=deep`).
- `scope=<files|diff|HEAD~N>` — default: the working diff against
  `HEAD`. Accepts an explicit file list, a `git diff` range, or `all`
  for the current working tree.

### Tier → domains

| Tier | Domains |
|------|-------------|
| `light` | logic, simplification |
| `standard` | logic, security, simplification, architecture |
| `deep` | logic, security, simplification, research, architecture |

Triage may pick any subset across these tiers. When `tier` is forced,
the static mapping above is used.

## Posture

Even in default mode this skill is licensed to improve the repo
**agnostic to scope, current quality, and conventions**. Conventions
are not a defense. If a function is a 200-line tangle, flag it even
if every neighboring function is also 200 lines. If an import pattern
is wrong in 20 files, it is still wrong — flag the diff and add a
NOTE for the broader cleanup. The goal is to leave the touched code
better than the average of its surroundings, not to match the average.

## Process

1. **Resolve scope**. From the args, build the file list and capture
   the diff. Group by layer (frontend, backend, shared). Note
   immediate imports/exports — neighbor files in scope for
   cross-cutting checks.

   Diff capture: `git diff <range> > /tmp/hawk-code-audit-diff.patch 2>&1`. Get the file list with `git diff --name-only <range>` (small, inline). Specialist user-prompts receive per-file `rg -n` slices of the capture, never the raw concatenated diff.

2. **Triage** (when `tier=auto`). Spawn the `audit-triage` subagent.
   Its system prompt and decision rules already live in the agent
   file — pass only the per-call context:

> **pi harness note.** `subagent_type` is limited to `explore|plan|coder`; the
> agent profile is selected with `agent_file`. The Claude Code spelling
> `Agent(subagent_type="<profile>")` is a schema error here, and the profile
> pins that used to name `sonnet`/`haiku` are gone so these inherit the session
> route (provider- and model-agnostic).
   ```
   agent(subagent_type="explore", agent_file="audit-triage", prompt=<USER PROMPT>)
   ```

   Where `<USER PROMPT>` contains:
   - **Changed files** — output of `git diff --name-only --stat <range>`.
   - **Risk-signal greps** — narrowed `rg -n` matches over the diff
     capture for each PATH and DIFF signal listed in the agent's
     body (capped at ~30 lines total). Omit signals with no matches.
   - **Scope stats** — `files: N`, `lines added/removed: +A/-B`,
     `layers spanned: <e.g. db, api, ui>`.

   Parse the structured reply:

   ```
   tier: <light|standard|deep>
   specialists: <subset>
   reason: <…>
   ```

   The triage decision is **not surfaced to the user** — log it
   internally and proceed. (If the user explicitly asks "why these
   specialists?", show the `reason`.)

   **If the reply doesn't parse** (missing `tier:` line, unknown tier
   value, empty specialists list, or no response): fall back to
   `tier=standard` (logic, security, simplification, architecture)
   and continue. Bias is up — never silently skip the audit because
   triage misbehaved.

   When `tier` is forced, skip this step and use the static mapping.

3. **Load shared context** (orchestrator only — pasted into each
   specialist's user prompt):
   - `.agents/standards/` (read `index.yml`, then the relevant files).
   - `.agents/common-mistakes/` (read `index.yml`, then the relevant
     files).
   - The check command for the project (`bun run c`, `pnpm typecheck`,
     `mix test`, etc.). Look it up — do not assume.

4. **Deterministic review (main path).** This always runs, first, for
   every domain in the triage subset. Run `rg -n` over the diff
   capture for each domain's signal set (see *Deterministic review*
   below) and promote every match to a FIX / NOTE / QUESTION. This is
   the primary findings source — the audit is complete even if no
   subagent runs or returns anything.

5. **Context gathering (optional subagents).** Optionally fan out
   `audit-*` subagents as **context gatherers**. One message, multiple
   Agent tool calls, for the domains in the triage subset:

> **pi harness note (`audit-research`).** This profile cannot be spawned on this
> box: `subagent_type` is limited by tool policy to `explore`, which drops
> web_search/web_fetch, and tmux subagents are not used here (background work
> goes through `bg_run`/`bg_delegate`). So do the web verification in the
> orchestrator, which holds `web_search`/`web_fetch` directly, and keep local
> evidence gathering in this skill. The profile itself is fine on harnesses whose
> policy allows web-capable subagents.
   ```
   agent(subagent_type="explore", agent_file="audit-logic",         prompt=<USER PROMPT>)
   agent(subagent_type="explore", agent_file="audit-security",      prompt=<USER PROMPT>)
   agent(subagent_type="explore", agent_file="audit-simplification",prompt=<USER PROMPT>)
