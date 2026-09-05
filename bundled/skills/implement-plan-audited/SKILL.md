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

```
Agent(subagent_type="audit-triage", prompt=<scope, signals>)
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

```
Agent(subagent_type="audit-logic",         prompt=<USER PROMPT>)
Agent(subagent_type="audit-security",      prompt=<USER PROMPT>)
Agent(subagent_type="audit-simplification",prompt=<USER PROMPT>)
Agent(subagent_type="audit-research",      prompt=<USER PROMPT>)
Agent(subagent_type="audit-architecture",  prompt=<USER PROMPT>)
```

Skip any role not in the triage subset.

**Do NOT call `Agent(subagent_type="code-audit", …)`.** `code-audit`
is a *skill*, not a subagent — it has no entry in `~/.claude/agents/`
and the Agent tool will reject it. The audit-* subagents are the
only callable gatherers; this skill is calling them directly here
in place of invoking `/code-audit`.

**Deterministic review is the main path.** Run the `rg` anti-pattern
signal checks over the checkpoint diff first, for every domain, and
promote each match to FIX/NOTE/QUESTION — this owns the findings. The
`audit-*` subagents then gather extra context and report raw
observations back to you; you do the classification and the reply. A
gatherer that returns empty or unparseable is harmless — skip it and
proceed; the deterministic review already produced the findings. See
`code-audit/SKILL.md` → "Deterministic review" for the per-domain
signal table. A checkpoint audit never dies because a model call
failed.

The agent body owns the role,
anti-bias contract, verification rule, and output schema. The
orchestrator's per-call user prompt contains only:

```
## Files / diff in scope

{{narrowed `rg -n` slices from the per-file captures}}

## Standards (pasted inline, do not fetch)

{{full content of every relevant `.agents/standards/` file}}

## Common mistakes (pasted inline, do not fetch)

{{full content of every relevant `.agents/common-mistakes/` file}}

## Context

This diff covers Inc {{X}}–{{Y}}. Do NOT look up which increments
those are or what they did — they are integer indices, nothing more.
```

Tell each gatherer which increment indices the diff covers (so they
can scale reasoning to the window size) but **never** reveal increment
titles, descriptions, or the plan path. The agent's anti-bias contract
already forbids reading `.plans/`; do not weaken it by pasting goal
context here.

### Step 4 — Reconcile

When all gatherers return:

1. **Merge the deterministic findings with the gatherers' raw
   observations** the same way `code-audit` merges them — dedupe by
   `path:line`, attach overlapping reasoning, surface QUESTIONs
   immediately.
2. **Apply** depends on mode:
   - `auto` — apply every FIX directly. Run the check command. If it
     fails: fix the breakage (max 3 attempts). After 3 failed attempts,
     **fall back to manual mode**: stop, surface the audit output and
     the failing diff, and wait for user input.
   - `manual` — present the merged FIX list to the user. Apply only
     what the user approves. Then run the check command.
3. **Plan-override flagging**: if the merged output reveals that the
   approach taken in any covered increment was structurally wrong (a
   gatherer's `Why:` describes a fundamentally cleaner
   architecture, or a fix touches the public API the plan specified),
   surface this as a "plan-override" item to the user even in auto
   mode. Auto mode still applies the fix; the user gets a
   notification at the next completion summary so they can decide
   whether to update later increments.
4. **Behavior preservation**: any FIX that changes external behavior
   must be surfaced even if applied. Auto mode does not get to
   silently change behavior.

Because a checkpoint covers multiple increments, the merged FIX list
will often be larger than a per-increment audit. Group findings by
file in the user-facing report so reviewers can scan quickly.

### Step 5 — Commit hygiene (optional)

If the user wants commits per increment, commit after each increment
implements (before the checkpoint gate). At the checkpoint, after
reconcile, make a separate `audit:` commit for any fixes applied —
this keeps audit cleanup separable from
feature work in `git log`.

Message style: single-line, imperative. Use `feat({slug}): …` for
increments and `audit({slug}): cleanup for Inc X–Y` for checkpoint
fixes. No Co-Authored-By unless explicitly requested.

In auto mode, commits per increment plus a separate audit commit
per checkpoint are recommended — they make it easy to bisect after
a long run and to revert audit changes independently if needed.

### Step 6 — Completion

When all increments are `done` (or `blocked-on-user`):

1. If the final increment was not a checkpoint and there is uncovered
   work since the last checkpoint, run one final checkpoint audit
   now (this should be rare — Step 1.5 promotes the final increment
   to a checkpoint by default).
2. Run a final check command.
3. Summarize to the user:
   - Increments completed and blocked.
   - Number of audit checkpoints run, and which increments each
     checkpoint covered.
   - Total fixes applied across all audits, broken down by domain.
   - Plan-override flags raised.
   - Any unresolved NOTEs.
   - Any QUESTIONs that the audit surfaced and the orchestrator
     answered (and how) vs. surfaced for the user.
4. **Compound**: run `/compound` to close the loop — answer the three
   golden questions and write the learnings to `.agents/learnings/`
   so the next plan starts smarter. In `auto` mode this runs
   hands-off; in `manual` mode surface the proposed learning for
   approval before writing.

## Auto mode — failure handling

Auto mode is designed for unattended runs. Its failure ladder:

1. Increment implementation fails check command 3× → stop, fall back
   to manual.
2. Audit specialists return → applied → check command fails 3× →
   stop, fall back to manual.
3. A specialist surfaces a QUESTION it can't resolve → stop, ask the
   user (auto mode does not guess on blocking questions).
4. A plan-override is raised → apply the fix, **continue** (do not
   stop), but surface in the completion summary so the user can
   propagate to later increments if desired.

Stopping in auto mode means: print the current state, the merged
audit output, and the failing diff. Wait for user input. Do not
revert.

## Rules

- Audits run **only at annotated checkpoints**, not after every
  increment. Step 1.5 computes the cadence; the loop honors it.
- Gatherers run **in parallel** as fresh subagents. The subset per
  checkpoint is decided by triage (or by an explicit `tier=`); a
  single-pass non-parallel audit is never allowed.
- Triage runs once per checkpoint, not once per skill invocation —
  different checkpoints in the same run can legitimately land on
  different tiers.
- Gatherer prompts are self-contained and blind: no plan path, no
  goal, no chat history. They may be told which increment indices
  the diff covers, but never their titles or descriptions.
- The plan file is updated with `**Audit checkpoint:** yes` lines
  during Step 1.5, then with `done` status and at most a one-line
  audit note under each checkpoint increment. Audit outputs do
  **not** leak into the plan otherwise.
- User-authored `**Audit checkpoint:** yes` lines are respected
  verbatim — the heuristic only fires when the plan has none.
- Auto mode never silently changes external behavior — those FIXes
  are always surfaced.
- Auto mode has a hard floor of 3 retries before falling back to
  manual; it will not loop forever.
- Honor user-level conventions: one-line commits, no
  Co-Authored-By, no `--no-verify`, no silent lint dismissal. These
  apply to both modes.
- **Big-output discipline.** Heavy command output (project check, full `git diff`, repo-wide search, long log, large fetch) goes to `/tmp/hawk-implement-plan-audited-<step>.log`, then `rg -n '<pattern>' /tmp/hawk-implement-plan-audited-<step>.log | head -50` extracts what you need. `Read` the file only with `offset`/`limit`. See README → Big-output discipline. In auto mode, never paste a raw /tmp capture into the conversation — only narrowed slices.




## Calling models via Ollama

Always set `num_predict` in `/api/chat` options — too small → empty
`content`; uncapped → runaway. Recommended: `temperature: 0.7`,
`top_p: 0.9`, `num_batch: 512`, `repeat_penalty: 1.1`, `repeat_last_n: 64`.
Empty content + long thinking → raise `num_predict`; huge output → cap
missing. Prefer 4-bit quants for tool calling. Full detail: README →
"Calling models via Ollama".
