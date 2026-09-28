---
name: implement-plan-audited
description: Execute a plan increment-by-increment with deterministic `rg` anti-pattern checks as the main audit path at strategic checkpoints, and audit-* subagents gathering extra context. Before execution, the orchestrator annotates the plan with audit checkpoints based on increment sizes (e.g. after a single L, after two M, after a few S). Two modes — `manual` stops between increments for user review, `auto` applies audit fixes and proceeds without interruption (designed for hours of unattended execution). Audit subagents are blind to the plan and the goal, so they evaluate code on its own merits.
---

# Implement Plan (Audited)

Same execution shape as `implement-plan`, plus strategic **audit
checkpoints**: at annotated increments (not after every one), the
deterministic `rg` anti-pattern checks run against the cumulative diff
since the previous checkpoint (the main path), with `audit-*`
subagents gathering extra context. The orchestrator classifies the
findings and auto-applies fixes (auto mode) or surfaces them for
review (manual mode). The domain subset is decided per checkpoint by
`audit-triage`.

Checkpoints are computed and written into the plan file before
execution starts — after a few small increments, two mediums, one
large, etc. A 10-increment plan typically gets ~3 audits, not 10.

The `audit-*` gatherers are independent and blind: they do not read
the plan, the increment text, or the user's goal — only the diff and
their specialist brief. See `code-audit/SKILL.md` for the orchestration
shape and `~/.claude/agents/audit-*.md` for the briefs. That blindness
is the point: an audit that knows the plan defends it; one that only
sees the code evaluates it.

## When to use this skill vs `implement-plan`

- `implement-plan` — trust the plan, get it done.
- `implement-plan-audited` (manual) — the plan is a starting point;
  work gets stress-tested at audit checkpoints (after a few small
  increments / a couple of mediums / one large). Stops between
  increments so you can review.
- `implement-plan-audited` (auto) — same checkpoint cadence, no user
  gate. Use when you want to leave a plan running for hours and come
  back to a finished, audited result. Failure auto-falls-back to
  manual.

## Args

- `mode=manual|auto` — default `manual`.
- `tier=auto|light|standard|deep` — default `auto`. Passed through to
  each checkpoint audit. `auto` calls `audit-triage` per checkpoint
  and lets it pick the domain subset for that checkpoint's diff.
  Explicit values force the same tier on every checkpoint. See
  `code-audit/SKILL.md` for the static tier→specialist mapping.
  Replaces the old `agents=full|light` knob.
- `plan=<path>` — explicit plan file path. Default: detect from `.plans/`.

## Process

### Step 0 — Locate and load the plan

Same as `implement-plan` — read the plan file, match standards and
common mistakes, summarize to the user. Also read relevant learnings
from `.agents/learnings/` (read `index.yml`, then the files whose
`Reuse` mentions this plan's files/domains).

### Step 1 — Bootstrap context

Same as `implement-plan` Step 1. Capture the project check command. The
orchestrator will need it for verification gates. Also capture the
current git ref (`git rev-parse HEAD`) — the first checkpoint's audit
diff is computed against it.

All check-command runs in this skill follow the **Big-output discipline**: redirect to `/tmp/hawk-implement-plan-audited-<step>.log` and inspect with `rg -n 'error|warning|fail|FAIL' /tmp/hawk-implement-plan-audited-<step>.log | head -50`. `<step>` is e.g. `inc3-check`, `ckpt2-check`, `final-check`.

### Step 1.5 — Annotate audit checkpoints into the plan

Before any code is written, walk the plan's increments in order and
decide where audits will run. The result is written **into the plan
file** as `**Audit checkpoint:** yes` lines under selected increments
so that:

- The cadence is visible to the user before execution starts.
- A fresh session resuming the plan inherits the same cadence.
- The execution loop has a single source of truth.

**Heuristic** — assign each increment a weight by its size estimate:

| Size | Weight |
| ---- | ------ |
| S    | 1      |
| M    | 2      |
| L    | 4      |

Walk increments in dependency order. Maintain a running
`accumulated_weight`, starting at 0. For each increment:

1. Add its weight to `accumulated_weight`.
2. If `accumulated_weight >= 4`, mark this increment as a checkpoint
   and reset `accumulated_weight = 0`.

After the walk, if the **final increment** is not already a checkpoint
**and** `accumulated_weight > 0` (i.e. there is uncovered work at the
tail), promote the final increment to a checkpoint so nothing ships
unaudited.

Edge case — manual / user-driven increments
(`Status: blocked-on-user`): skip them when accumulating weight, and
do not mark them as checkpoints. The next executable increment can
own a checkpoint instead.

**Worked examples:**

- 10 × S → checkpoints after Inc 4, Inc 8, Inc 10 → **3 audits**.
- 5 × M → checkpoints after Inc 2, Inc 4, Inc 5 → **3 audits**.
- 1 × L → checkpoint after Inc 1 → **1 audit**.
- S, S, M, S, L, M, M → after Inc 4 (S+S+M+S=5), after Inc 5 (L=4),
  after Inc 7 (M+M=4) → **3 audits**.

**Annotation format** — for each chosen checkpoint increment, insert a
single line directly under its `**Done criteria:**` line (or under the
increment heading if no done-criteria line exists):

```
**Audit checkpoint:** yes
```

Do not modify any other part of the plan. After annotation, summarize
to the user (in both modes): "Annotated N audit checkpoints across M
increments — audits will run after: Inc X, Inc Y, Inc Z."

If the plan already contains `**Audit checkpoint:** yes` lines (e.g.
the user added them by hand, or this is a resumed run), **trust them
and skip the heuristic** — the user's choices win. Just summarize the
inherited cadence.

### Step 2 — Execution loop

For each increment in dependency order:

1. **Implement** — follow `implement-plan` Step 3 (read files, write
   code, run the check command until clean, self-review against common
   mistakes).
2. **Mark done** — update the increment's `**Status**:` to `done` in the
   plan file. Do **not** rewrite the plan to leak prior audit context
   into future increments — keep the plan stable so later increments
   are not biased.
3. **Checkpoint gate** — if this increment is annotated
   `**Audit checkpoint:** yes`:
   - **Audit** on the cumulative diff since the previous checkpoint
     (or the pre-execution ref captured in Step 1, for the first
     checkpoint) — see Step 3 below. Domain subset is decided
     per checkpoint by `audit-triage`.
   - **Reconcile** — see Step 4.
   - Append at most a one-line audit note under the checkpoint
     increment (e.g. `audit: 3 small fixes applied, 0 plan-overrides,
     covered Inc 5–7`).
   - Update the "previous checkpoint ref" to the current `git
     rev-parse HEAD`.
4. **Mode gate**:
   - `manual` — pause and report the increment outcome (and audit
     outcome, if a checkpoint just ran) before starting the next
     increment.
   - `auto` — proceed to the next increment immediately. No prompts.

Manual/user-driven increments (e.g. "hand-write context and verify in
prod") are marked `blocked-on-user` and skipped, regardless of mode.

### Step 3 — Run the checkpoint audit

At a checkpoint, capture the **cumulative diff** since the previous
checkpoint ref (or the pre-execution ref for the first checkpoint).
**Per-file enumeration first, then per-file capture** — never the
raw concatenated cumulative diff:

```bash
git diff --name-only <prev_checkpoint_ref>..HEAD > /tmp/hawk-implement-plan-audited-files-<ckpt>.log
# for each file in that list:
git diff <prev_checkpoint_ref>..HEAD -- <path> > /tmp/hawk-implement-plan-audited-diff-<ckpt>-<file-slug>.patch 2>&1
```

Gatherer user prompts receive narrowed `rg -n` slices from the
per-file captures, never the full cumulative diff.

**Per-checkpoint triage** (when `tier=auto`, the default). Before
reviewing, call:

> **pi harness note.** `subagent_type` is limited to `explore|plan|coder`; the
> agent profile is selected with `agent_file`. The Claude Code spelling
> `Agent(subagent_type="<profile>")` is a schema error here, and the profile
> pins that used to name `sonnet`/`haiku` are gone so these inherit the session
> route (provider- and model-agnostic).
```
agent(subagent_type="explore", agent_file="audit-triage", prompt=<scope, signals>)
```

Input: the checkpoint's file list, scope stats (lines +/-, layers
spanned, increments covered), and the narrowed risk-signal greps.
The agent returns a tier and domain subset **for this checkpoint
only** — different checkpoints in the same run can legitimately land
on different tiers. Triage decision is internal; record it in the
per-checkpoint audit note (e.g. `audit: 3 small fixes applied, 0
plan-overrides, covered Inc 5–7`) but do not surface it to the user
unless asked.

When `tier` is forced (`light|standard|deep`), skip the triage call
and use the static mapping in `code-audit/SKILL.md`.

**If the triage reply doesn't parse** (missing `tier:`, unknown tier,
empty subset, or no response): fall back to `tier=standard` for this
checkpoint and continue. Auto mode does **not** stop on a malformed
triage — bias is up.

**Fan out the context gatherers in parallel** — one message, one Agent
call per role in the triaged subset. Use the concrete agent names so
install-time prefix rewriting stays consistent:

> **pi harness note (`audit-research`).** `subagent_type="explore"` is the only
> value this harness's tool policy permits, and it drops web_search/web_fetch, so
> this one profile is spawned through the `subagent` tool (its own tool loadout)
> instead. If that path is restricted too, do the web verification in the
> orchestrator — it has web_search/web_fetch — and keep the profile for local
> evidence gathering.
```
agent(subagent_type="explore", agent_file="audit-logic",         prompt=<USER PROMPT>)
agent(subagent_type="explore", agent_file="audit-security",      prompt=<USER PROMPT>)
agent(subagent_type="explore", agent_file="audit-simplification",prompt=<USER PROMPT>)
