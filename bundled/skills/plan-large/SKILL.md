---
name: plan-large
description: Plan a large feature spanning multiple PRs or requiring architectural decisions. Writes a technical, increment-by-increment plan to .plans/<slug>/plan.md (with optional sibling files), runs the same code-search-first question gate as plan-small, then runs deterministic structural checks over the plan (main path) with the plan-reviewer subagent gathering extra context, and improves the plan before presenting it. Use when the user describes multi-day work, cross-system changes, or sequencing dependencies.
---

# Plan a Large Feature

A large plan is a DAG of increments, each of which is the size of a
`plan-small` plan. The output of this skill is a `.plans/<slug>/`
directory whose `plan.md` is technical enough that an implementer in a
fresh session can execute any increment without re-deriving design
decisions.

Quality gates (same shape as `plan-small`, scaled up):

1. **Question gate** — search code first, then ask only what code can't
   answer. Surface core architectural assumptions/decisions alongside
   questions.
2. **File output** — `.plans/<slug>/plan.md` is mandatory. Sibling files
   are optional and produced when their content exists.
3. **Self-improving review** — deterministic structural checks over
   the plan (main path) own the findings; the `plan-reviewer`
   subagent gathers extra context. Findings are applied before
   presenting.

The legacy "consider running /review-plan" suggestion is gone — the
deterministic review pass is mandatory and built in.

## Process

### Step 1 — Gather the design

Ask the user (or extract from the description) for:

- The problem this solves and for whom.
- High-level approach they're leaning toward.
- Known constraints (tech stack, timeline, team, deploy story).
- Open questions they already know about.

For initial codebase investigation, dispatch up to 3 `Explore`
subagents in parallel (one for existing patterns, one for related
components, one for testing patterns) to keep planning context
clean. Each Explore brief includes the canonical Big-output discipline Rules bullet verbatim, and instructs the subagent to capture repo-wide searches to `/tmp/hawk-plan-large-explore-<n>.log` and return narrowed findings, not raw captures.

### Step 2 — Load context

- Standards from `.agents/standards/` (read `index.yml`, then
  relevant files).
- Common-mistakes from `.agents/common-mistakes/`.
- Learnings from `.agents/learnings/` (read `index.yml`, then the
  files whose `Reuse` mentions this plan's files/domains).
- Project check command.

### Step 3 — Question gate (search code, then ask)

Identical mechanism to `plan-small` Step 3:

1. Generate the questions that will shape architecture, increment
   order, and integration points.
2. **Search the code first** for each. If the answer is in the code,
   record it as `Answered from code: … — see <file:line>` and don't
   ask.
3. In **one** `AskUserQuestion` call, surface:
   - The remaining questions.
   - The **core architectural assumptions and decisions** the skill
     is planning to take. Examples relevant at this scale:
     - "I'm planning to keep the new feature behind a feature flag —
       confirm or override."
     - "I'm assuming the migration runs online (no downtime) using
       the existing `pgmigrate` setup — confirm or override."
     - "I'm planning to add a new `billing/` module rather than
       extend `payments/` — confirm or override."

### Step 4 — Adversarial pre-write pass (in your head)

Before writing the plan, stress-test the design:

- Top 5 risks or failure modes.
- At least one alternative architecture and the strongest argument
  for it.
- Gaps: migrations, backwards compat, observability, rollback,
  data backfill, feature flags, deprecations.
- What to prototype first to de-risk the rest.

You do not commit alternatives to the plan file (the plan should
contain only the chosen approach). You **do** record the chosen
approach's rationale and the risks it accepts.

### Step 5 — Decompose into ordered increments

Each increment must:

- Be a single PR that passes CI independently.
- Move the feature measurably forward.
- Have explicit dependencies (which prior increments it needs) and
  what it unblocks.
- Have done criteria observable from outside the code.
- Be estimated S / M / L.
- For non-trivial increments: include concrete file specs (signatures,
  data shapes, integration points, error paths) — see the file-spec
  shape in `plan-small/SKILL.md`.

### Step 6 — Write the plan to file

Slug rule: kebab-case from the user's request, ≤4 words. If
`.plans/<slug>/` exists, append `-2`, `-3`, etc.

```
.plans/<slug>/
├── plan.md          # mandatory
├── shape.md         # optional — shaping decisions, alternatives considered
├── standards.md     # optional — which standards apply, with pointers
├── references.md    # optional — similar code in repo to learn from
└── visuals/         # optional — mockups, diagrams, screenshots
```

`plan.md` structure:

```markdown
# {{Title}}

## Context
The problem, the constraints, the intended outcome.

## Architectural decisions
- Decision: <decision>. Rationale: …. Alternatives rejected: …
- … (the chosen approach's load-bearing decisions, briefly justified)

## Assumptions and answers from code
- Decision: <decision>. Source: code @ <file:line> | user-confirmed | default.
- … (output of Step 3's code search and user-answer round)

## Risks accepted
- <risk>: <mitigation or "accept; revisit if X">

## Increment DAG
A short list of increments and their dependency edges. Example:

- Inc 1 — Foundation (S) — depends on: none — unblocks: 2, 3
- Inc 2 — Schema (M) — depends on: 1 — unblocks: 4, 5
- Inc 3 — API (M) — depends on: 1 — unblocks: 5
- ...

## Increments

### Inc 1 — <title> (S|M|L)
**Depends on:** …
**Unblocks:** …
**Done criteria:** observable, one-line.

#### Files to touch
For each file (mandatory for non-trivial increments):

##### path/to/file.ext
- What changes: <one line>
- Function(s): <signatures>
- Data shapes: <input/output types or pseudo-schema>
- Integration points: <callers / callees>
- Error paths: <failures and handling>

#### Edge cases
- …

#### Verification
- Run: <check command>
- Tests to add/update: …
- Done: …

### Inc 2 — …
…

## Cross-cutting verification
Any end-to-end checks that span multiple increments (e.g. "after Inc 5,
manually walk through the user flow at /widgets and confirm…").

## Standards / common-mistakes referenced
- <path> — applies to: …

## Open questions (CONSIDER from review)
- … (filled by the review pass; empty initially)

## Out of scope
- Explicit non-goals. Future work that isn't this plan.
```

### Step 7 — Deterministic review (main path)

Run the structural `rg` checks over `plan.md` first, for every check
in *Deterministic plan checks* below, and promote each match to
MUST-FIX / SHOULD-FIX / CONSIDER. This always runs and owns the
findings — the plan review is complete even if no subagent runs or
returns anything.

### Step 8 — Context gathering (optional subagent)

Call `plan-reviewer` as a **context gatherer**. Its system prompt —
anti-bias contract, the eight review dimensions, severity rules, and
output format — lives in `~/.claude/agents/plan-reviewer.md`. The
orchestrator sends only the per-call context:

```
Agent(subagent_type="plan-reviewer", prompt=<USER PROMPT>)
```

Where `<USER PROMPT>` is:

```
## Plan content

{{paste full plan.md content here}}

## Standards (pasted inline)

{{full content of relevant .agents/standards/ files}}

## Common mistakes (pasted inline)

{{full content of relevant .agents/common-mistakes/ files}}

## Posture: multi-increment plan

This plan is structured as a DAG of increments spanning multiple
PRs. In addition to the eight standard review dimensions, also
review:

9.  **Increment ordering and dependency correctness**:
    - Does Inc N depend on something Inc N-1 didn't produce?
    - Are any dependencies missing or wrong?
    - Does any increment do too much (split candidate)?
    - Could increments run in parallel that the DAG serializes?
10. **Backwards compatibility, migration, rollback, observability**:
    are these covered for each increment that ships independently?
```

The gatherer **does not classify findings**. It reads the plan and
reports raw observations back to you; you own all MUST-FIX /
SHOULD-FIX / CONSIDER classification and the final reply. A gatherer
that returns empty or unparseable is harmless — skip it and proceed;
the deterministic review in Step 7 already produced the findings.

### Step 9 — Apply review findings

Merge the deterministic findings (Step 7) with the gatherer's raw
observations (Step 8), doing the classification yourself:

- Apply every **MUST-FIX** directly to `.plans/<slug>/plan.md`.
- Apply every **SHOULD-FIX** directly. If a SHOULD-FIX conflicts with
  a user-confirmed decision from Step 3, downgrade it to a CONSIDER
  and flag it to the user instead of applying.
- Append every **CONSIDER** under "Open questions (CONSIDER from
  review)" in the plan file.
- If any MUST-FIX changes the increment DAG, update the "Increment
  DAG" section to match — the DAG and the increments must stay
  consistent.

### Step 10 — Present to user

Print:

- The plan directory path.
- A short summary (one paragraph).
- The increment DAG.
- The architectural decisions and assumptions list.
- The CONSIDER items.

Do not start implementing. Suggest `/implement-plan` (or
`/implement-plan-audited mode=auto` for hours-long unattended runs)
when the user is ready.

## Deterministic plan checks (main path)

Run each check with `rg`/`grep` over `plan.md` and promote every match
to a finding: unambiguous structural break → **MUST-FIX**; needs
judgment → **SHOULD-FIX**; nice-to-have → **CONSIDER**. Feed through
the normal merge/apply pipeline.

| Check | Signal (over plan.md) | Finding |
|---|---|---|
| **DAG ↔ sections** | An `Inc N` in "Increment DAG" has no `### Inc N` section, or a `### Inc N` section is absent from the DAG | MUST-FIX |
| **Dependency exists** | `**Depends on:**` references an `Inc N` that doesn't exist | MUST-FIX |
| **Unblocks exists** | `**Unblocks:**` references an `Inc N` that doesn't exist | MUST-FIX |
| **No forward deps** | `**Depends on:**` references an `Inc N` that appears later in the file | MUST-FIX |
| **Estimate tagged** | A `### Inc N` heading lacks `(S\|M\|L)` | MUST-FIX |
| **Done criteria** | An increment lacks `**Done criteria:**` | MUST-FIX |
| **Verification** | An increment lacks `#### Verification` | SHOULD-FIX |
| **Edge cases** | An increment lacks `#### Edge cases` | SHOULD-FIX |
| **Assumption sourced** | An assumption/decision line lacks `Source:` | SHOULD-FIX |
| **Out of scope** | Plan lacks `## Out of scope` | CONSIDER |
| **Cross-cutting** | Multi-increment plan lacks `## Cross-cutting verification` | CONSIDER |

## Rules

- The plan directory is mandatory — large features without persistent
  plans always degrade across sessions.
- Question gate first; never ask the user something the code already
  answers.
- Surface architectural assumptions alongside questions. The user
  cannot override what they don't see.
- Deterministic structural checks are the main path and always run.
  The `plan-reviewer` subagent only gathers context; it never gates
  the review.
- The gatherer is blind to `.plans/` — the orchestrator pastes the
  plan inline.
- Apply MUST-FIX and SHOULD-FIX before presenting. The user sees the
  improved plan, not the draft.
- The DAG and the increment list must stay consistent through any
  edit pass.
- Resist building everything at once. Increments are reviewable
  units; if an increment grows past one PR, split it.
- **Big-output discipline.** Heavy command output (project check, full `git diff`, repo-wide search, long log, large fetch) goes to `/tmp/hawk-plan-large-<step>.log`, then `rg -n '<pattern>' /tmp/hawk-plan-large-<step>.log | head -50` extracts what you need. `Read` the file only with `offset`/`limit`. See README → Big-output discipline. Explore subagent briefs and the gatherer subagent prompt include this bullet verbatim, and long standards files are narrowed via `rg` before being pasted in.




## Calling models via Ollama

Always set `num_predict` in `/api/chat` options — too small → empty
`content`; uncapped → runaway. Recommended: `temperature: 0.7`,
`top_p: 0.9`, `num_batch: 512`, `repeat_penalty: 1.1`, `repeat_last_n: 64`.
Empty content + long thinking → raise `num_predict`; huge output → cap
missing. Prefer 4-bit quants for tool calling. Full detail: README →
"Calling models via Ollama".
