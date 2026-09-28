---
name: review-large-pr
description: Review a large pull request (30+ changed files) using chunked review with synthesis. Each chunk is reviewed by deterministic `rg` anti-pattern checks (main path), with optional audit-* subagents gathering extra context, then synthesized into one consolidated report. Use when a PR is too large for a single audit pass.
---

# Review a Large PR

The strategy: partition the PR into coherent chunks, run the
deterministic `rg` anti-pattern checks against each chunk (the main
path), optionally fan out the `audit-*` subagents as context
gatherers, then synthesize across chunks. Specialist briefs and
anti-bias contracts live in the agent files (`audit-triage`,
`audit-logic`, `audit-security`, `audit-simplification`,
`audit-research`, `audit-architecture`) — this skill orchestrates.

## Process

1. **Scope and partition.** Get the file list (`git diff --name-only`,
   inline — small). Group files into review chunks of max ~10 files
   each, organized by logical coherence:
   - Same domain or entity
   - Same architectural layer (schemas, core logic, routers, triggers,
     frontend)
   - Files that import each other belong in the same chunk

   For each file in scope, capture a per-file diff:

   ```
   git diff -- <path> > /tmp/hawk-review-large-pr-chunk-<n>-<file-slug>.patch 2>&1
   ```

   **Never** capture or read the concatenated multi-file diff — large
   PRs are exactly the case Big-output discipline exists for.

2. **Per-chunk review.** For each chunk, run the same pattern as
   `code-audit`:

   a. **Triage** (always — this is a large PR; right-sizing the
      domains per chunk is the whole point of partitioning).
> **pi harness note.** `subagent_type` is limited to `explore|plan|coder`; the
> agent profile is selected with `agent_file`. The Claude Code spelling
> `Agent(subagent_type="<profile>")` is a schema error here, and the profile
> pins that used to name `sonnet`/`haiku` are gone so these inherit the session
> route (provider- and model-agnostic).
      Call `agent(subagent_type="explore", agent_file="audit-triage", prompt=<chunk scope, signals>)`.
      Triage decision is internal; record it in the chunk report
      header but do not surface to the user unless asked. If triage's
      reply doesn't parse, fall back to `tier=standard` for that
      chunk and continue.

   b. **Deterministic review (main path).** For each domain in the
      triaged subset, run `rg -n` for its anti-pattern signals over
      the chunk's capture files and promote every match to
      FIX/NOTE/QUESTION. This always runs and owns the findings — see
      `code-audit/SKILL.md` → "Deterministic review" for the
      per-domain signal table.

   c. **Context gathering (optional subagents).** Fan out the
      `audit-*` subagents as **context gatherers** for the triaged
      subset. Use the concrete agent names — install-time prefix
      rewriting depends on it:

> **pi harness note (`audit-research`).** This profile cannot be spawned on this
> box: `subagent_type` is limited by tool policy to `explore`, which drops
> web_search/web_fetch, and tmux subagents are not used here (background work
> goes through `bg_run`/`bg_delegate`). So do the web verification in the
> orchestrator, which holds `web_search`/`web_fetch` directly, and keep local
> evidence gathering in this skill. The profile itself is fine on harnesses whose
> policy allows web-capable subagents.
      ```
      agent(subagent_type="explore", agent_file="audit-logic",         prompt=<chunk user prompt>)
      agent(subagent_type="explore", agent_file="audit-security",      prompt=<chunk user prompt>)
      agent(subagent_type="explore", agent_file="audit-simplification",prompt=<chunk user prompt>)
