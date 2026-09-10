---
description: Run a thorough, source-heavy investigation on a topic and produce a durable research brief with inline citations.
args: <topic>
section: Research Workflows
topLevelCli: true
---
## Tool Discipline (Read First)

Tool names are literal. Use only tools visible in the current tool set.

- Search with `web_search`; do not call `search_web`, `google_search`, `google:search`, `search_google`, or `WebSearch`.
- Fetch URLs with `web_fetch` using `{url: "https://…"}`; do not call `fetch_content`, bare `fetch`, `WebFetch`, or `read_url_content`.
- Use visible Feynman alpha tools such as `alpha_search` when present. For shell access, call `feynman alpha ...`; do not call the user's bare global `alpha` binary.
- To ask the user a question, write plain chat text and wait for the next user message. Do not call `ask_user_question`, `ask_user`, `ask_followup_question`, or `user_choice`.
- Do not use the tmux-based `subagent` tool. Run parallel research with the built-in pi background system instead:
  - `bg_run` with a `pi -p "…"` child (`isAgent: true`) — the primary mechanism. The child writes its findings to a file; you get a terminal notification on completion, then read the file. A `pi -p` child uses normal max_tokens (no 935k-token reservation), so it works on low-credit accounts where the tmux subagent harness fails.
  - `bg_delegate` — read-only repo investigation (no network; not for web research).
  - `fusion_research` / `fusion_investigate` — five-model workflows for targeted URL research / bounded repo investigation.
  - `run_background` / `agent` — built-in harness subagents (explore/plan/coder types) when they fit.
- If `web_search` is unavailable (e.g. "Missing Google Custom Search credentials"), treat it as blocked: fall back to `web_fetch` on known URLs (repos, docs, search-engine result pages) and record the capability as blocked in the provenance.
- If a tool returns `Tool not found` or `Invalid URL`, do not retry the same invalid call. Map to a canonical visible tool and valid arguments, or record the capability as blocked.

Run deep research for: $@

This is an execution request, not a request to explain or implement the workflow instructions.
Execute the workflow. Do not answer by describing the protocol, do not explain these instructions, and do not restate the protocol. Your first actions should be tool calls that create directories and write the plan artifact.

## Required Artifacts

Derive a short slug from the topic: lowercase, hyphenated, no filler words, at most 5 words.

Every run must leave these files on disk:
- `outputs/.plans/<slug>.md`
- `outputs/.drafts/<slug>-draft.md`
- `outputs/.drafts/<slug>-cited.md`
- `outputs/<slug>.md` or `papers/<slug>.md`
- `outputs/<slug>.provenance.md` or `papers/<slug>.provenance.md`

After the user approves the plan, if any capability fails, continue in degraded mode and still write a blocked or partial final output and provenance sidecar. Never end with chat-only output after plan approval. Never end with only an explanation in chat after plan approval. Use `Verification: BLOCKED` when verification could not be completed.

## Step 1: Plan

Create `outputs/.plans/<slug>.md` immediately. The plan must include:
- Key questions
- Evidence needed
- Scale decision
- Task ledger
- Verification log
- Decision log

Make the scale decision before assigning owners in the plan. If the topic is a narrow "what is X" explainer, the plan must use lead-owned direct search tasks only; do not allocate research agents in the task ledger.

Also save the plan with `memory_remember` using key `deepresearch.<slug>.plan` if that tool is available. If it is not available, continue without it.

After writing the plan, stop and ask for explicit confirmation before gathering evidence. Summarize the plan briefly and ask:

`Proceed with this deep research plan? Reply "yes" to continue, or tell me what to change.`

Do not run searches, fetch sources, spawn agents, draft, cite, review, or deliver final artifacts until the user confirms. If the user requests changes, update `outputs/.plans/<slug>.md` first, then ask for confirmation again.

## Step 2: Scale

Use direct search for:
- Single fact or narrow question, including "what is X" explainers
- Work you can answer with 3-10 tool calls

For "what is X" explainer topics, you MUST NOT spawn research agents unless the user explicitly asks for comprehensive coverage, current landscape, benchmarks, or production deployment.
Do not inflate a simple explainer into a multi-agent survey.

Use background research agents only when decomposition clearly helps:
- Direct comparison of 2-3 items: 2 `bg_run` research children
- Broad survey or multi-faceted topic: 3-4 `bg_run` research children
- Complex multi-domain research: 4-6 `bg_run` research children

Each child is a `bg_run` task running `pi -p "<task>"` with `isAgent: true`. The child reads a brief file you wrote (e.g. `outputs/.plans/<slug>-T1.md`) and writes its findings to a file under `outputs/.drafts/`. Optionally load the bundled role profile (e.g. `~/.pi/agent/agents/researcher.md`) via `--append-system-prompt <path>`. You collect the files after the terminal notifications arrive.

## Step 3: Gather Evidence

Use only tool names visible in the current tool set. For web search, call `web_search`; never call `google:search`, `google_search`, or `search_google`.

Avoid crash-prone PDF parsing in this workflow. Do not call `alpha_get_paper` and do not fetch `.pdf` URLs unless the user explicitly asks for PDF extraction. Prefer paper metadata, abstracts, HTML pages, official docs, and web snippets. If only a PDF exists, cite the PDF URL from search metadata and mark full-text PDF parsing as blocked instead of fetching it.

If direct search was chosen:
- Skip research-agent spawning entirely.
- Search and fetch sources yourself.
- Use multiple search terms/angles before drafting. Minimum: 3 distinct queries for direct-mode research, covering definition/history, mechanism/formula, and current usage/comparison when relevant.
- Record the exact search terms used in `outputs/.drafts/<slug>-research-direct.md`.
- Write notes to `outputs/.drafts/<slug>-research-direct.md`.
- Continue to synthesis.

If background research agents were chosen:
- Write a per-researcher brief first, such as `outputs/.plans/<slug>-T1.md`.
- Keep the `bg_run` task text small and valid: the task should point the child at its brief and its output path, not carry multi-paragraph instructions.
- Launch each researcher as a `bg_run` task:

```bash
bg_run name="T1-web-research" isAgent=true \
  command="pi -p 'Read outputs/.plans/<slug>-T1.md and write your findings to outputs/.drafts/<slug>-research-web.md. Follow the brief: web search + web fetch, no PDF parsing (mark BLOCKED), no invented sources, record your search terms.' --no-session > outputs/.drafts/<slug>-T1-run.log 2>&1"
```

- Do not name exact tool commands in the child task unless those tool names are visible in the current tool set. Prefer broad guidance such as "use web search and web fetch"; if a PDF parser or paper fetch fails, the researcher must continue from metadata, abstracts, and web sources and mark PDF parsing as blocked.
- Wait for the terminal notifications (do not poll). After each completes, verify the output file exists on disk. If a child failed (provider error, hang, credit limit), record exactly what failed and continue in degraded mode: do that task yourself with direct search, or mark it blocked.

After evidence gathering, update the plan ledger and verification log. If research failed, record exactly what failed and proceed with a blocked or partial draft.

## Step 4: Draft

Write the report yourself. Do not delegate synthesis.

Save to `outputs/.drafts/<slug>-draft.md`.

Include:
- Executive summary
- Findings organized by question/theme
- Evidence-backed caveats and disagreements
- Open questions
- No invented sources, results, figures, benchmarks, images, charts, or tables

Before citation, sweep the draft:
- Every critical claim, number, figure, table, or benchmark must map to a source URL, research note, raw artifact path, or command/script output.
- Remove or downgrade unsupported claims.
- Mark inferences as inferences.

## Step 5: Cite

If direct search/no research agents was chosen:
- Do citation yourself.
- Verify reachable HTML/doc URLs with available fetch/search tools.
- Copy or rewrite `outputs/.drafts/<slug>-draft.md` to `outputs/.drafts/<slug>-cited.md` with inline citations and a Sources section.
- Do not spawn a verifier agent for simple direct-search runs.

If background research agents were used, run the verifier pass after the draft exists. This step is mandatory and must complete before any reviewer runs. Do not run the verifier and reviewer in the same parallel call.

Use this shape (a `bg_run` child):

```bash
bg_run name="verifier" isAgent=true \
  command="pi -p 'Add inline citations to outputs/.drafts/<slug>-draft.md using the research files as source material. Verify every URL. Write the complete cited brief to outputs/.drafts/<slug>-cited.md.' --no-session > outputs/.drafts/<slug>-verifier-run.log 2>&1"
```

After the verifier returns, verify on disk that `outputs/.drafts/<slug>-cited.md` exists. If the verifier wrote elsewhere, find the cited file and move or copy it to `outputs/.drafts/<slug>-cited.md`.

## Step 6: Review

If direct search/no research agents was chosen:
- Review the cited draft yourself.
- Write `outputs/.drafts/<slug>-verification.md` with FATAL / MAJOR / MINOR findings and the checks performed.
- Fix FATAL issues before delivery.
- Do not spawn a reviewer agent for simple direct-search runs.

If background research agents were used, only after `outputs/.drafts/<slug>-cited.md` exists, run the reviewer pass against it.

Use this shape (a `bg_run` child):

```bash
bg_run name="reviewer" isAgent=true \
  command="pi -p 'Verify outputs/.drafts/<slug>-cited.md. Flag unsupported claims, logical gaps, single-source critical claims, and overstated confidence. This is a verification pass, not a peer review. Write your findings to outputs/.drafts/<slug>-verification.md.' --no-session > outputs/.drafts/<slug>-reviewer-run.log 2>&1"
```

If the reviewer flags FATAL issues, fix them before delivery and run one more review pass. Note MAJOR issues in Open Questions. Accept MINOR issues.

When applying reviewer fixes, do not issue one giant `edit` tool call with many replacements. Use small localized edits only for 1-3 simple corrections. For section rewrites, table rewrites, or more than 3 substantive fixes, read the cited draft and write a corrected full file to `outputs/.drafts/<slug>-revised.md` instead.

After applying reviewer, verifier, audit, or PI-style fixes, run an explicit on-disk verification before saying the fixes landed. Use `rg`, `grep`, `diff`, `wc`, `stat`, or a targeted read to prove the old unsupported wording is gone and the replacement wording exists. If an `edit` or `write` tool call fails, do not describe the fix as applied; record the failure in the plan/provenance, retry with a smaller edit or a full corrected file, and verify again. Provenance may only say an issue was fixed when this post-edit verification passed.

The final candidate is `outputs/.drafts/<slug>-revised.md` if it exists; otherwise it is `outputs/.drafts/<slug>-cited.md`.

## Step 7: Deliver

Copy the final candidate to:
- `papers/<slug>.md` for paper-style drafts
- `outputs/<slug>.md` for everything else

Write provenance next to it as `<slug>.provenance.md`:

```markdown
# Provenance: [topic]

- **Date:** [date]
- **Rounds:** [number of research rounds]
- **Sources consulted:** [count and/or list]
- **Sources accepted:** [count and/or list]
- **Sources rejected:** [dead, unverifiable, or removed]
- **Verification:** [PASS / PASS WITH NOTES / BLOCKED]
- **Plan:** outputs/.plans/<slug>.md
- **Research files:** [files used]
```

Before responding, verify on disk that all required artifacts exist. If verification could not be completed, set `Verification: BLOCKED` or `PASS WITH NOTES` and list the missing checks.

Before responding, also verify that any fixes claimed in the provenance are reflected in the final candidate. If a fix removed a phrase, number, source, or claim, run a targeted `rg`/`grep` check for the removed content and a second check for the corrected content. Do not claim "all patches applied", "all checks pass", or "fixed" unless these commands or reads succeed.

Final response should be brief: link the final file, provenance file, and any blocked checks.
