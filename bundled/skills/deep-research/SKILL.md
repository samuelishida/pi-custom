---
name: deep-research
description: Run a thorough, source-heavy investigation on any topic. Use when the user asks for deep research, a comprehensive analysis, an in-depth report, or a multi-source investigation. Produces a cited research brief with provenance tracking.
---

# Deep Research

Run the `/deepresearch` workflow. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

The workflow uses the built-in pi background system (no tmux): `bg_run` with `pi -p` children for parallel research/verifier/reviewer roles, `bg_delegate` for read-only repo investigation, and `fusion_research`/`fusion_investigate` for five-model research. The tmux-based `subagent` tool is not used. If `web_search` is unavailable (missing credentials), fall back to `web_fetch` on known URLs and record the capability as blocked.

Output: cited brief in `outputs/` with `.provenance.md` sidecar.
