# pi harness: the subagent spawn contract

## Context

A call failed with a schema error, not a runtime one:

```
agent  Research review of iGPU mode diff  researcher
Validation failed for tool "agent":
  - subagent_type: must be equal to one of the allowed values
```

Two compounding causes, and only one of them is visible in that message.

**Cause 1 — model pins in the agent profiles.** Seven of ten profiles in
`~/.pi/agent/agents/` pinned a Claude alias in frontmatter (`model: sonnet` on the
five `audit-*` gatherers and `plan-reviewer`, `model: haiku` on `audit-triage`).
This box has no Anthropic provider — the configured providers are hipfire, ollama,
memllm, flashnext and the codex CLI — so the pin cannot resolve. It also
contradicts the standing policy in `~/.pi/agent/AGENTS.md`: *"Background runs …
must use the session route: inherit the parent session's provider and model …
Never substitute a different provider or a cloud model for a background run."*
`researcher`, `reviewer` and `verifier` never had a pin; they were already
agnostic, and the pins are now removed from all seven, so every profile inherits
the session route.

**Cause 2 — another harness's call syntax.** Every hawk-skill instructed the
Claude Code form:

```
Agent(subagent_type="audit-logic", prompt=<USER PROMPT>)
```

That is a schema error here. The measured contract:

| thing | value on this box |
|---|---|
| `agent` / `agent_swarm` `subagent_type` | `StringEnum(["explore","plan","coder"])` — `pi-muselinn-harness/index.ts:795`, `:1271` |
| where the profile goes | the separate `agent_file` parameter (`:839`, `:1280`), validated against `agent_file_list`; an unknown name returns "Agent profile \"X\" not found" |
| tool policy | only `subagent_type="explore"` is permitted — `"coder"` and `"plan"` both return `Tool "agent" is disabled by the active tool policy.` |
| tools an `explore` child actually gets | `{read, grep, find, ls, bash}` — read-only, so a profile's declared `write`/`edit` **and** `web_search`/`web_fetch` are dropped |
| model routing | an `explore` child ran as `ollama:deepseek-v4.1-flash:cloud` while the session was on a local route: the tier router overrides the profile layer's inherited route, so `model`/`model_tier` must be passed per spawn to pin a route |

Corrections applied (2026-09-28):

* 7 profiles: `model:` pin removed (backups `*.bak-modelpin-*`).
* 44 call sites in `~/.pi/agent/skills/`, 22 more in `~/.agents/skills/` (a
  duplicate tree carrying the same text) and 22 in `bundled/skills/`:
  `Agent(subagent_type="X", prompt=…)` → `agent(subagent_type="explore",
  agent_file="X", prompt=…)`, plus a short harness note so the reasoning travels
  with the skill. The two `Do NOT call Agent(subagent_type="code-audit")`
  warnings were reworded — a *skill* name is not an agent profile.
* `audit-research` is **not spawned at all** on this box: verified web access is
  that profile's entire purpose, `explore` strips it, and the obvious alternative
  -- the `subagent` tool, which loads a profile's own tool loadout -- is the
  tmux-based path this box has ruled out (background work goes through
  `bg_run`/`bg_delegate`). The skills now say to do the web verification in the
  orchestrator, which holds `web_search`/`web_fetch` directly, and to keep local
  evidence gathering in the skill. The profile itself stays valid for harnesses
  whose policy allows web-capable subagents.

## Hardest decision

Rewriting the skills' call syntax rather than documenting a mapping and leaving
the Claude Code form in place. The mapping would be cheaper and more portable to
other harnesses, but what executes is the literal text in the skill: leaving
`Agent(subagent_type="<profile>")` in a skill that is *loaded to be followed* is
the same bug waiting to happen. So the call sites were corrected mechanically
(and verified by grep that no instance survives), with a one-line note in each
skill recording why.

## Alternatives rejected

* **Keeping `model: sonnet`** because it "works on machines with Anthropic." It
  silently cannot resolve here, which is the worst failure mode: the profile
  looks configured but is not.
* **Patching the tool schema to accept profile names in `subagent_type`.**
  Attractive because it would make the existing skills valid without edits, but
  the enum is deliberate (it selects the base agent behaviour and the tool
  policy) and `agent_file` already exists for exactly this purpose. Changing the
  tool to match one harness's legacy spelling would have broken the contract for
  every other skill.
* **Blanket-pairing every profile with `explore`.** It looked fine — all seven
  profiles are read-only gatherers — but spawning a child and asking it which
  tools it actually had showed that `explore` drops `web_search`/`web_fetch`.
  `audit-research` would have been quietly neutered into a filesystem-only
  reader.

## Least confident

* Whether the `subagent` tool would preserve a profile's web tools under the same
  policy is unknown, and deliberately not pursued: it is the tmux path this box
  excludes. The orchestrator does that work instead.
* Whether a *future* tool-policy change makes `coder`/`plan` spawnable. The policy
  is the reason the fan-out is restricted to `explore` today; if it loosens, the
  corrected call sites would still work and `audit-research` could move back to a
  spawned role.
* Whether `pi-muselinn-harness` normalizes the capitalized Claude tool names in
  `audit-*.md` (`Read, Grep, Glob, Bash, WebSearch, WebFetch`) against its own
  lowercase tools. It did not matter in practice — `explore` supplied the
  functionally equivalent set — but the declared lists may not be matched
  name-for-name.
* The `explore` tool set is inferred from one child's self-report. A profile
  declaring `disallowedTools` was not exercised.

## Reuse

* **Write skills against the harness that will execute them.** `Agent(subagent_type=…)`
  is Claude Code; `agent(subagent_type="explore", agent_file="<profile>")` is this
  one. A skill is instructions, so an invalid instruction is a bug, not a doc
  issue.
* **Never pin a model in an agent profile here.** Omit `model:` and the profile
  inherits the session route. Pins that name another vendor's aliases are the
  most likely thing to break silently after a reinstall or a copy from another
  machine.
* **Verify a spawn path by spawning one child and asking what tools it has.**
  A schema-valid call can still be functionally gutted by the type policy, and
  the child's self-report is the cheapest way to see it. (This is how the
  `audit-research` gap was found instead of shipped.)
* **When a tool rejects an argument, read the tool's own schema source** —
  `grep` the extension that registers it (`pi-muselinn-harness/index.ts`) for
  the `StringEnum` and the sibling parameters. That took one minute and beat
  guessing at the error text.
