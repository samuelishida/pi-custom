---
name: compound
description: Close the Plan → Work → Review → Compound loop. After any completed work cycle, extract the learnings deterministically (the three golden questions), write them to .agents/learnings/ as searchable institutional knowledge, and index them so the next plan-* / implement-* cycle reads them as grounding. Invoked directly, or auto-run at the end of implement-plan / implement-plan-audited.
---

# Compound

The return arrow. Every unit of work should make the next one easier.
This skill captures what a work cycle taught the system so the next
cycle starts smarter — instead of re-deriving the same lessons.

The main path is deterministic: the orchestrator asks itself the three
golden questions and writes the answers to `.agents/learnings/`. No
subagent is required. A subagent is only used when the work was large
enough that the orchestrator can't reconstruct the decisions from
memory — and even then it gathers context, it doesn't classify.

## When to run

- **Auto** — at the end of `implement-plan` / `implement-plan-audited`
  (after the final check passes).
- **Direct** — after a `code-audit` cleanup, a `fix-bug`, a `refactor`,
  a `remove-code`, or any session where you learned something the
  next session shouldn't have to rediscover.

## The three golden questions (deterministic main path)

Ask yourself all three. Answer each in one or two lines. If an answer
is empty, leave it empty — do not pad.

1. **What was the hardest decision you made here?**
   The tricky part, the judgment call, the tradeoff that wasn't
   obvious. This is where the next implementer will get stuck.
2. **What alternatives did you reject, and why?**
   The options you considered and the reason you didn't take them.
   This prevents the next person from re-litigating a settled choice.
3. **What are you least confident about?**
   Where you might be wrong. The thing to verify, watch, or revisit.

## Process

1. **Run the three golden questions.** Answer them from the work just
   completed. Be concrete — name files, functions, and the specific
   decision, not a general platitude.

2. **Decide whether a subagent is needed.** Only if the work spanned
   many files or sessions and you can't reconstruct the decisions from
   memory, dispatch one `Explore` subagent to gather the context
   (what changed, what was decided, what's uncertain) and report raw
   observations back. It does not write the learning — you do.

3. **Write the learning.** One file per topic, kebab-case, under
   `.agents/learnings/`:

   ```
   .agents/learnings/<topic>.md
   ```

   Structure:

   ```markdown
   # <Topic>

   ## Context
   What was being built / fixed / changed. One or two lines.

   ## Hardest decision
   <answer to golden question 1>

   ## Alternatives rejected
   - <option> — <why rejected>

   ## Least confident
   <answer to golden question 3>

   ## Reuse
   Where this applies next: which files, functions, or future work
   should read this. One or two lines.
   ```

   If a `<topic>.md` already exists, **append** a new dated section
   under the relevant heading rather than overwriting — learnings
   accumulate.

4. **Index it.** Add a topic → file mapping to
   `.agents/learnings/index.yml` (create it if missing):

   ```yaml
   <topic>:
     file: <topic>.md
     description: <one line — when to read this>
   ```

   The `plan-*` and `implement-*` skills read `index.yml` first, so a
   learning only compounds if it's indexed.

5. **Report.** One line: the topic, the file path, and the single
   most important learning. Do not dump the whole file.

## Rules

- The three golden questions are the main path and always run. A
  subagent only gathers context; it never writes the learning.
- Learnings are concrete, not platitudes. "The migration must run
  online" beats "migrations are hard."
- One file per topic; append, don't overwrite. Learnings accumulate.
- Always update `index.yml` — an unindexed learning is invisible to
  the next plan.
- Keep it short. A learning that takes a minute to read compounds; a
  learning that takes ten minutes to read is documentation debt.
- **Big-output discipline.** If a subagent gathers context, heavy
  command output goes to `/tmp/hawk-compound-<step>.log`, then
  `rg -n '<pattern>' /tmp/hawk-compound-<step>.log | head -50`
  extracts what you need. `Read` the file only with `offset`/`limit`.
  See README → Big-output discipline.




## Calling models via Ollama

Always set `num_predict` in `/api/chat` options — too small → empty
`content`; uncapped → runaway. Recommended: `temperature: 0.7`,
`top_p: 0.9`, `num_batch: 512`, `repeat_penalty: 1.1`, `repeat_last_n: 64`.
Empty content + long thinking → raise `num_predict`; huge output → cap
missing. Prefer 4-bit quants for tool calling. Full detail: README →
"Calling models via Ollama".
