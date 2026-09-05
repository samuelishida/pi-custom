import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeFs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodePath = require("node:path");

/** Message shape convertToLlm/serializeConversation accept (structural, not imported). */
type AnyMessage = { role: string; content: unknown };

/** Minimal structural shape we need from event.preparation (see SessionBeforeCompactEvent). */
type Preparation = {
  firstKeptEntryId: string;
  tokensBefore: number;
  previousSummary?: string;
  fileOps?: { readFiles: string[]; modifiedFiles: string[] };
  messagesToSummarize: AnyMessage[];
  turnPrefixMessages: AnyMessage[];
};

/** Runtime model fields used to resolve the real Ollama num_ctx. */
type ActiveModel = { id: string; baseUrl?: string; provider?: string; contextWindow?: number };

/** Native (non-`/v1`) Ollama HTTP endpoint; absolute fallback matches 127.0.0.1/localhost:11434. */
const OLLAMA_BASE = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\/?$/i;

/**
 * Context-dependent compaction reserve + summarization-overflow safety net.
 *
 * A) Context-dependent reserve.
 *    pi's settings.json `compaction.reserveTokens` is a single fixed token
 *    count, which mis-sizes the compaction threshold across very different
 *    context windows. This extension makes the reserve grow with the model's
 *    window so the compaction line lands where a larger window wants it:
 *
 *        reserve(window) = min( MIN_RESERVE + GROWTH * max(0, window - BASE_WINDOW),
 *                               window * MAX_FRACTION )
 *        compactLine     = window - reserve(window)
 *
 *    Calibrated to the requested operating points:
 *      Qwen 27B (122,880)   -> reserve 32,768   -> compact at ~90,112
 *      DeepSeek (1,048,576) -> reserve ~524,288 -> compact at ~524,288
 *
 * G) Mid-run watchdog: pi only checks context at run boundaries, so one long
 *    continuous tool loop can blow past the window with no compaction (seen:
 *    2.5h loop 35k -> 583k, 115% of 500k). We now gate at every `turn_end`
 *    and compact when the dynamic line is crossed mid-run.
 *
 * B) Overflow safety net (the fix).
 *    pi's built-in summarizer serializes the whole history-to-summarize into a
 *    SINGLE LLM request. If a single turn is huge, that request can exceed the
 *    model's real context and Ollama returns `exceed_context_size_error` (400)
 *    — e.g. the observed 167,166 tokens into a 122,880 window. The
 *    `session_before_compact` event lets a plugin return its own `compaction`
 *    result instead, bypassing that overflowing summarizer call. We measure the
 *    ACTUAL serialized size of what the summarizer would send (via pi's own
 *    `serializeConversation`); when it would not fit, we supply a bounded
 *    fallback summary (previous summary + file lists) so compaction always
 *    succeeds. Everything that fits keeps the normal, high-quality LLM summary.
 *
 * C) Real context-window discovery.
 *    pi's `ctx.model.contextWindow` for a custom Ollama model is a hardcoded
 *    `models.json` value or the model's MAX context (e.g. 262,144) — NOT the
 *    `num_ctx` set in the Modelfile (e.g. 147,456). We query Ollama's native
 *    `/api/show` once per model (cached, with a timeout) and use that
 *    effective window for the dynamic line and the overflow guard, so any
 *    custom Ollama model is handled by its true context. Priority: the
 *    Modelfile `num_ctx` parameter, then `model_info.<arch>.context_length`
 *    (what newer Ollama reports for models with no explicit num_ctx — e.g.
 *    cloud models, whose real 1,048,576 context was previously missed and
 *    fell back to pi's 500k).
 *
 * We never interfere with reason="overflow" recovery and manual /compact unless
 * the input genuinely would not fit the window — and settings.compaction.enabled
 * stays true so the overflow-retry safety net remains intact.
 */

const BASE_WINDOW = 122_880; // window at which the reserve is at its floor
const MIN_RESERVE_TOKENS = 32_768; // reserve at/under BASE_WINDOW (the 2x default you asked for)
const RESERVE_GROWTH = 0.531; // how fast the reserve grows per extra window token
const MAX_FRACTION = 0.5; // never reserve more than half the window
const PROACTIVE_THROTTLE_MS = 120_000; // min gap between proactive compacts
const NO_PROGRESS_DELTA = 1_000; // tokens must advance this much before re-triggering
const OVERFLOW_SAFE_FRACTION = 0.85; // trigger the bounded-summary fallback when the serialized summarization input exceeds 85% of the window
const CHAR_PER_TOKEN = 4; // pi's own chars/4 conservative token estimate
const PROMPT_OVERHEAD_TOKENS = 600; // summarization system prompt + wrappers + instructions

// ---------------------------------------------------------------------------
// Local-quant robustness guardrails (section D).
// ---------------------------------------------------------------------------
// D) Broken tool-call detection + auto-continue.
//    Quantized models (Q4/Q5) frequently emit a *text* fragment instead of a
//    real tool call — e.g. a Write whose `content` is a snippet ending in raw
//    `</function>`/`</parameter>`/`</content>` markers, or a call with missing /
//    empty required args. pi's `tool_call` event can return `{ block, reason }`:
//    the reason is fed back to the model as a tool error and the agent loop
//    continues automatically — exactly the "detect broken and auto continue"
//    behavior. We block only clearly-broken calls so legit calls pass through.
//
// D2) Stall / hang watchdog.
//    Local models occasionally stop emitting tokens entirely. We track the last
//    streaming/tool activity and, if an agent turn runs with no activity for
//    STALL_TIMEOUT_MS, gently re-prompt it to resume.
const STALL_TIMEOUT_MS = 360_000; // no activity in 6 min -> treat as hung, then retry by re-prompting
const STALL_POLL_MS = 5_000; // watchdog poll interval
const STALL_RETRY_CAP = 2; // max retries per run before giving up
const HUNG_TOOL_ABORT_CAP = 1; // max aborts per run for a hung/crashed tool call
const STALL_TOOL_MARGIN_MS = 15_000; // grace added to a tool's own declared timeout before we intervene
const TOOL_CALL_MARKER_RE = /<(?:\/?)(?:function|invoke|parameter|parameters|content|output|result)\b/i;
const BROKEN_ARGS_CAP = 3; // max blocks for the same tool+call before letting it through
const GARBLED_CALL_RE =
  /<\/?(?:function|invoke|parameter|parameters|tool_call|tool_result|content|output|result)\b|\{"?text\":|parameter=[0-9a-zA-Z]|<\/?tool_call\b/i;
const GARBLED_RETRY_CAP = 2; // max re-injections per run before giving up

// ---------------------------------------------------------------------------
// Real Ollama num_ctx discovery.
//
// pi's `ctx.model.contextWindow` for a custom Ollama model is either a value
// hardcoded in `~/.pi/agent/models.json` or the model's MAX context length
// (e.g. 262,144) — NOT the `num_ctx` actually set in the Modelfile (e.g.
// 147,456), which is what Ollama truly serves. Reading the wrong (larger)
// number makes compaction trigger too late and lets the summarizer overflow
// the real window.
//
// The authoritative source is the native Ollama HTTP API `POST
// {base}/api/show`, which returns `modelfile`/`parameters` containing
// `num_ctx`. We query it once per model and cache the result.
// ---------------------------------------------------------------------------
const ctxCache = new Map<string, number>(); // key: base + "/" + model id
const OLLAMA_SHOW_TIMEOUT_MS = 8_000; // a hanging /api/show must not stall event handlers

/** Derive the native Ollama API base from a baseUrl (strip trailing "/v1"). */
function ollamaNativeBase(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  const clean = baseUrl.replace(/\/v1\/?$/, "");
  if (OLLAMA_BASE.test(clean) || OLLAMA_BASE.test(clean.replace(/(:\d+)\/?$/, ""))) return clean;
  return undefined;
}

/**
 * Fetch the effective window for a model from Ollama's /api/show (cached).
 *
 * Priority: the Modelfile `num_ctx` parameter (authoritative when present, e.g.
 * local quantized models) -> the `model_info.<arch>.context_length` (newer
 * Ollama reports the model's max context there when no num_ctx is set, e.g.
 * for cloud models) -> undefined (caller falls back to pi's contextWindow).
 * Bounded by a timeout so a slow proxy can't stall the extension handlers.
 */
async function fetchNumCtx(model: ActiveModel): Promise<number | undefined> {
  const base = ollamaNativeBase(model.baseUrl);
  if (!base) return undefined;
  const key = `${base}/${model.id}`;
  if (ctxCache.has(key)) return ctxCache.get(key);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), OLLAMA_SHOW_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model.id }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    const text = JSON.stringify(data ?? {});
    const numCtx = text.match(/num_ctx\"?\s*[:=\s]+(\d+)/);
    const contextLength = text.match(/"context_(?:length|window)"\s*:\s*(\d+)/);
    const m = numCtx ?? contextLength;
    if (m) {
      const num = Number(m[1]);
      if (num > 0) {
        ctxCache.set(key, num);
        return num;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the effective context window: Ollama num_ctx, else pi's model value. */
async function effectiveWindow(model: ActiveModel): Promise<number> {
  const num = await fetchNumCtx(model);
  return num ?? model.contextWindow ?? 0;
}

export default function guardrail(pi: ExtensionAPI) {
  // Per-session state (reset on session_start so a fresh session isn't gated
  // by a previous session's token counts).
  let lastCancelledTokens = 0;
  let lastProactiveAt = 0;
  // True while a compaction WE triggered is still running. pi's
  // session.compact() is not re-entrant: two overlapping ctx.compact() calls
  // race on the single _compactionAbortController field and one dies with
  // "Cannot read properties of undefined (reading 'signal')". This flag keeps
  // our own turn_end/agent_settled triggers from ever starting a second one,
  // and lets us cancel pi's built-in threshold check while one is in flight.
  let compactionInFlight = false;

  const reserveFor = (contextWindow: number): number => {
    const linear = MIN_RESERVE_TOKENS + RESERVE_GROWTH * Math.max(0, contextWindow - BASE_WINDOW);
    // Never reserve a negative amount (tiny windows would otherwise push the
    // dynamic line past the window itself).
    return Math.min(Math.floor(Math.max(0, linear)), Math.floor(contextWindow * MAX_FRACTION));
  };

  const dynamicLine = (contextWindow: number): number =>
    contextWindow - reserveFor(contextWindow);

  /** Estimate tokens the built-in summarizer would send for these messages. */
  const estimateSummaryTokens = (
    messagesToSummarize: AnyMessage[],
    turnPrefixMessages: AnyMessage[],
  ): number => {
    const llmMessages = convertToLlm([...messagesToSummarize, ...turnPrefixMessages] as any);
    const serialized = serializeConversation(llmMessages as any);
    // pi truncates tool results, but a huge turn still serializes large. Estimate
    // conservatively with chars/4 like pi's own estimateTokens, plus prompt overhead.
    return Math.ceil(serialized.length / CHAR_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS;
  };

  const buildBoundedSummary = (prep: Preparation): string => {
    const lines: string[] = [];
    if (prep.previousSummary) {
      lines.push(prep.previousSummary.trim());
    } else {
      lines.push(
        "## Goal\n[Session continues. No prior summary existed; context was too large to summarize in a single request.]",
      );
    }
    const modified = [...new Set(prep.fileOps?.modifiedFiles ?? [])];
    const read = [...new Set(prep.fileOps?.readFiles ?? [])];
    if (modified.length > 0) {
      lines.push(`### Modified Files\n${modified.map((f) => `- ${f}`).join("\n")}`);
    }
    if (read.length > 0) {
      lines.push(`### Read Files\n${read.map((f) => `- ${f}`).join("\n")}`);
    }
    lines.push(
      "> (Fallback summary: the conversation history exceeded the model context window, so detail beyond file operations was not re-summarized. Recent messages are preserved.)",
    );
    return lines.join("\n\n");
  };

  pi.on("session_start", async (_event, ctx) => {
    lastCancelledTokens = 0;
    lastProactiveAt = 0;
    compactionInFlight = false;
    streamGarbled = false;
    const model = ctx.model as ActiveModel | undefined;
    if (!model) return;
    const w = await effectiveWindow(model);
    if (w && w > 0) {
      ctx.ui?.notify?.(
        `guardrail: real num_ctx=${w} (pi=${model.contextWindow ?? "?"}) -> compact at ~${Math.round(dynamicLine(w) / 1000)}k`,
        "info",
      );
    }
  });

  // Primary handler: delay below the dynamic line, overflow-safe fallback above it.
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model as ActiveModel | undefined;
    if (!model) return;
    const window = await effectiveWindow(model);
    if (window <= 0 || !event.preparation) return;
    const prep = event.preparation as Preparation;

    // (B) OVERFLOW SAFETY: measure the ACTUAL serialized input the built-in
    // summarizer would send. `tokensBefore` is the live context the model last
    // saw (which can be well under the window), but the summarizer re-serializes
    // the whole turn-prefix + history into ONE request — a huge turn can push
    // that past the model window and Ollama returns exceed_context_size_error
    // (e.g. 167,166 tokens into a 122,880 window). When the serialized input
    // would not fit, supply a bounded summary (no LLM call) instead.
    const summaryInputTokens = estimateSummaryTokens(prep.messagesToSummarize ?? [], prep.turnPrefixMessages ?? []);
    if (summaryInputTokens > window * OVERFLOW_SAFE_FRACTION) {
      lastProactiveAt = Date.now();
      return {
        compaction: {
          summary: buildBoundedSummary(prep),
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
        },
      };
    }

    // (A) Dynamic reserve: only delay when it's safe (the summarizer can fit).
    if (event.reason !== "threshold") return; // never touch manual / overflow paths
    // If we already have a compaction in flight (e.g. from the turn_end
    // watchdog), cancel pi's own post-agent_end threshold check so the two
    // never run concurrently (see compactionInFlight).
    if (compactionInFlight) return { cancel: true };
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;
    if (usage.tokens < dynamicLine(window)) {
      lastCancelledTokens = usage.tokens;
      return { cancel: true };
    }
    // Above the dynamic line: let the built-in compaction proceed.
  });

  // 2) Proactively compact early for large windows.
  pi.on("agent_settled", async (_event, ctx) => {
    stallEnd(); // end any in-flight stall tracking
    if (Date.now() - lastProactiveAt < PROACTIVE_THROTTLE_MS) return;
    const usage = ctx.getContextUsage();
    const model = ctx.model as ActiveModel | undefined;
    if (!usage || usage.tokens === null || !model) return;
    const window = await effectiveWindow(model);
    if (window <= 0) return;
    // No progress since the last delayed compaction (e.g. right after a
    // compaction landed): don't loop.
    if (usage.tokens <= lastCancelledTokens + NO_PROGRESS_DELTA) return;
    if (usage.tokens > dynamicLine(window)) {
      if (compactionInFlight) return; // a compaction is already running; don't stack
      compactionInFlight = true;
      lastProactiveAt = Date.now();
      ctx.compact({
        onComplete: () => {
          compactionInFlight = false;
        },
        onError: () => {
          compactionInFlight = false;
        },
      }); // fire-and-forget; its session_before_compact fires with reason="manual"
    }
  });

  // -------------------------------------------------------------------------
  // G) Mid-run runaway-context watchdog.
  //    pi only evaluates compaction at run boundaries (`agent_end`, or before
  //    the next user prompt), and `agent_settled` — where we proactively
  //    compact — also only fires once the run settles. A long continuous
  //    tool-call loop therefore grows past the dynamic line with NO check at
  //    all (observed: a session ran 17:32 -> 20:32 with usage growing
  //    35k -> 584k and zero compactions because the model never stopped
  //    emitting tool calls, so neither pi nor this extension ever got a
  //    chance to act).
  //    `turn_end` fires after EVERY LLM turn — including tool-use turns, once
  //    the tool results are in — so it is the right per-turn checkpoint. When
  //    usage crosses the dynamic line we trigger compaction right there:
  //    `ctx.compact()` aborts the current run at the (safe) turn boundary,
  //    waits for the run to unwind, then runs the normal compaction. The
  //    PROACTIVE_THROTTLE_MS guard set here prevents `agent_settled` from
  //    starting a second, concurrent compaction while the first unwinds.
  // -------------------------------------------------------------------------
  pi.on("turn_end", async (event, ctx) => {
    const msg = (event as any)?.message as any;
    if (msg && (msg.stopReason === "aborted" || msg.stopReason === "error")) return;
    if (Date.now() - lastProactiveAt < PROACTIVE_THROTTLE_MS) return;
    const usage = ctx.getContextUsage();
    const model = ctx.model as ActiveModel | undefined;
    if (!usage || usage.tokens === null || !model) return;
    // Cheap floor: below the smallest possible dynamic line there is nothing
    // to do, so we don't even touch the (cached but async) window lookup.
    if (usage.tokens <= BASE_WINDOW - MIN_RESERVE_TOKENS) return;
    const window = await effectiveWindow(model);
    if (window <= 0) return;
    if (usage.tokens <= dynamicLine(window)) return;
    if (compactionInFlight) return; // never start a second concurrent compaction
    compactionInFlight = true;
    lastProactiveAt = Date.now(); // blocks the agent_settled path from double-firing
    ctx.ui?.notify?.(
      `guardrail: context ${Math.round(usage.tokens / 1000)}k crossed the ${Math.round(dynamicLine(window) / 1000)}k line mid-run; compacting now`,
      "warn",
    );
    ctx.compact({
      onComplete: () => {
        compactionInFlight = false;
        // ctx.compact() aborted the in-flight run, so the agent is idle once
        // compaction finishes. Resume the interrupted task with a small nudge
        // (the same pattern pi-auto-compact used) so the session doesn't stall.
        setImmediate(() => {
          if (ctx.isIdle()) {
            const piAny = pi as any;
            const steer = (piAny.sendUserMessage ?? piAny.sendMessage).bind(piAny);
            steer(
              "[guardrail] Auto-compact ran mid-run. Resume where we left off and continue the task.",
              { deliverAs: "steer", expandPromptTemplates: false },
            );
          }
        });
      },
      onError: (err: Error) => {
        compactionInFlight = false;
        ctx.ui?.notify?.(`guardrail: mid-run compaction failed: ${err.message}`, "warn");
      },
    });
  });

  // -------------------------------------------------------------------------
  // D) Broken tool-call guardrail: detect malformed/truncated tool calls and
  //    block them so the model receives an error and auto-continues.
  // -------------------------------------------------------------------------
  const brokenByTool = new Map<string, number>(); // per-tool block count -> broken call

  /** Return a human-readable reason if the tool call is clearly broken, else undefined. */
  const brokenToolReason = (toolName: string, input: Record<string, unknown>): string | undefined => {
    // (i) Args are not an object (truncated/raw text).
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return `Tool ${toolName} arguments are malformed (not a JSON object).`;
    }
    // (2) Required string fields missing / empty for the common write-path tools.
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    if (toolName === "write" || toolName === "edit") {
      if (!str(input.path)) return `Tool ${toolName} is missing a required non-empty "path".`;
    }
    if (toolName === "write") {
      const content = str(input.content);
      if (!content) return `Tool ${toolName} is missing required "content".`;
    }
    if (toolName === "bash") {
      if (!str(input.command)) return `Tool ${toolName} is missing a required "command".`;
    }
    if (toolName === "read" || toolName === "grep" || toolName === "find") {
      if (!str(input.path) && !str(input.pattern)) {
        return `Tool ${toolName} is missing a required "path" (or "pattern").`;
      }
    }
    return undefined;
  };

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const reason = brokenToolReason(toolName, input);
    if (!reason) return; // healthy call -> let it run
    const prior = brokenByTool.get(toolName) ?? 0;
    if (prior >= BROKEN_ARGS_CAP) return; // already retried too much; let it through
    brokenByTool.set(toolName, prior + 1);
    ctx.ui?.notify?.(`guardrail: blocked broken ${toolName} call -> ${reason}`, "warn");
    return { block: true, reason };
  });

  // -------------------------------------------------------------------------
  // D1) Garbled-turn recovery: detect when the model leaks raw tool-call markup
  //     into plain text / thinking tokens (pi then parses zero valid calls and
  //     the agent just stops) and re-prompt by queueing a steering message.
  //     Works on BOTH streaming (message_update) and at turn_end, and fires even
  //     when a tool result exists (the leak is in the assistant TEXT regardless).
  // -------------------------------------------------------------------------
  let garbledRetries = 0; // per-run budget to avoid infinite retry loops

  const extractAssistantText = (msg: any): string => {
    if (!msg || !Array.isArray(msg.content)) return "";
    return msg.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("\n");
  };

  // Strong leaked-tool-call signatures. The generic <tag> density check catches
  // clusters; the regex catches the specific markup names/attribute forms.
  const looksLikeGarbledToolCall = (text: string): boolean => {
    if (!text || text.length === 0) return false;
    const t = text.trim();
    if (GARBLED_CALL_RE.test(t)) return true;
    const tagCount = (t.match(/<\/?[a-zA-Z][^>]*>/g) ?? []).length;
    return tagCount >= 3 && tagCount * 10 > t.length;
  };

  // Streaming net: set a flag the moment leaked markup starts streaming so we
  // know to recover even if the turn ends with a (parsed) tool result.
  let streamGarbled = false;
  pi.on("message_update", async (event) => {
    const m = (event as any)?.message as any;
    if (!m || m.role !== "assistant") return;
    const text = extractAssistantText(m);
    if (text && looksLikeGarbledToolCall(text)) streamGarbled = true;
  });

  const doGarbledRecovery = (ctx: any): void => {
    if (garbledRetries >= GARBLED_RETRY_CAP) return; // give up to avoid a loop
    garbledRetries++;
    const piAny = pi as any;
    const steer = (piAny.sendUserMessage ?? piAny.sendMessage).bind(piAny);
    steer(
      "[guardrail] Your previous turn leaked raw tool-call markup into plain text (e.g. <parameter>...</function>...</tool_call>) instead of a valid tool call. Re-issue the intended tool call as ONE clean, well-formed call. If you have actually finished the task, just reply with a concise answer instead.",
      { deliverAs: "steer", expandPromptTemplates: false },
    );
    ctx?.ui?.notify?.(
      `guardrail: detected garbled tool-call output; injected a steering re-prompt (retry ${garbledRetries}/${GARBLED_RETRY_CAP})`,
      "warn",
    );
  };

  pi.on("turn_end", async (event, ctx) => {
    const msg = (event as any).message as any;
    if (!msg || msg.role !== "assistant") return;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
    const text = extractAssistantText(msg);
    // Fire whenever the assistant TEXT contains leaked markup, regardless of
    // whether pi happened to parse one tool call out of it. (The leak is the
    // corruption; a single parsed call does not make it clean.)
    if (!streamGarbled && !looksLikeGarbledToolCall(text)) return;
    doGarbledRecovery(ctx);
    streamGarbled = false;
  });
  // Reset the garbled-retry budget when the whole run settles (a steering
  // re-prompt begins a new turn; we must NOT reset the cap mid-run).
  pi.on("agent_settled", async () => {
    garbledRetries = 0;
  });

  // -------------------------------------------------------------------------
  // F) Tool-error continuation guardrail.
  //    Requirement: the agent must NEVER stop on its own unless the task is
  //    finished or the user takes over. pi's loop only continues when the
  //    assistant message contains a tool call; a text-only turn after a tool
  //    error would end the run (agent stops). Instead of giving up, keep
  //    re-prompting: the model must re-issue a corrected tool call, deliver a
  //    plausible final answer, or be superseded by the user.
  // -------------------------------------------------------------------------
  let lastTurnHadError = false; // set when the previous turn's tool results errored
  let errorContinuationRetries = 0; // per-run budget (safety net vs. pathological loops)
  const ERROR_CONTINUATION_CAP = 6; // generous; see agent_settled reset below

  // "Finished" detection: allow the run to end only when the reply reads like
  // a real completion, not a give-up. Short texts must start with an explicit
  // completion phrase ("Done.", "Task complete."); long structured answers are
  // treated as final reports. Everything else (e.g. "I can't...", "the edit
  // failed because...") is treated as a give-up and re-prompted.
  const COMPLETION_RE = /^(?:done|all done|finished|complete|completed|task complete|that'?s it|i'?m done)[.!]?\b/i;
  const looksLikeCompletion = (text: string): boolean => {
    const t = (text ?? "").trim();
    if (!t) return false;
    if (t.length <= 400 && COMPLETION_RE.test(t)) return true; // short + explicit completion
    return t.length > 800; // long structured answer = final report
  };

  const containsToolCall = (msg: any): boolean =>
    !!msg && Array.isArray(msg.content) && msg.content.some((c: any) => c?.type === "toolCall");

  const turnHadError = (toolResults: any[] | undefined): boolean =>
    Array.isArray(toolResults) && toolResults.some((r: any) => r?.isError === true);

  pi.on("turn_end", async (event, ctx) => {
    const msg = (event as any).message as any;
    if (!msg || msg.role !== "assistant") return;
    const toolResults = (event as any).toolResults as any[];
    const hasErrorThisTurn = turnHadError(toolResults);
    const hasToolCall = containsToolCall(msg);

    // A prior turn errored and THIS turn is text-only: pi would end the run.
    // Keep it alive unless the reply reads like a real completion.
    if (lastTurnHadError && !hasToolCall && !hasErrorThisTurn) {
      if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
        if (looksLikeCompletion(extractAssistantText(msg))) {
          lastTurnHadError = false; // task finished: stopping is allowed
        } else if (errorContinuationRetries < ERROR_CONTINUATION_CAP) {
          errorContinuationRetries++;
          const piAny = pi as any;
          const steer = (piAny.sendUserMessage ?? piAny.sendMessage).bind(piAny);
          steer(
            "[guardrail] A tool call in the previous step failed and you replied without retrying. Do not stop — re-issue a corrected tool call to complete the task (e.g. fix the argument and retry). If the task is genuinely finished, confirm that in one short sentence and stop.",
            { deliverAs: "steer", expandPromptTemplates: false },
          );
          ctx.ui?.notify?.(
            `guardrail: tool errored and the model replied without retrying; injected a continue re-prompt (retry ${errorContinuationRetries}/${ERROR_CONTINUATION_CAP})`,
            "warn",
          );
          // Do NOT clear the latch here: if the model again replies with text
          // only, we re-nudge instead of letting the run die silently.
        } else {
          lastTurnHadError = false; // safety net exhausted; stop nagging
          ctx.ui?.notify?.(
            `guardrail: model kept replying without retrying after ${ERROR_CONTINUATION_CAP} nudges; stopping (user can take over)`,
            "warn",
          );
        }
      }
      return;
    }

    // Update the error latch for the NEXT turn.
    lastTurnHadError = hasErrorThisTurn;
  });
  pi.on("agent_settled", async () => {
    lastTurnHadError = false;
    errorContinuationRetries = 0;
  });


  // -------------------------------------------------------------------------
  // D2) Stall watchdog: if a turn produces no streaming/tool activity for
  //     STALL_TIMEOUT_MS, gently re-prompt it to resume (instead of aborting).
  //     It must NOT preempt a tool that declares its own timeout: a command
  //     like `(timeout 400s)` is legitimately long-running and the tool itself
  //     will terminate at 400s and feed its result back to the LLM. We wait for
  //     that declared deadline (plus a margin) before intervening.
  // -------------------------------------------------------------------------
  let stallLastActivity = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stallCtx: any = undefined;
  let stallActive = false;
  let stallRetries = 0; // per-run stall-retry budget (reset on agent_settled)
  let hungToolAborts = 0; // per-run budget for aborting hung tool calls
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  // In-flight tool calls (tool_execution_start but no matching end yet). A
  // stale one means the agent is blocked waiting on a crashed/hung function.
  // Each entry records how long the tool itself is allowed to run (its declared
  // timeout, if any), so the watchdog does not abort before that deadline.
  const inFlightTools = new Map<string, { startedAt: number; declaredMs: number }>();

  // Extract a self-imposed timeout (in ms) from a bash-style tool call. Looks at
  // the schema-level `timeout` arg and also common `timeout 400s` / `(timeout 400)`
  // patterns embedded in the command string. Returns 0 when none is declared.
  const declaredTimeoutMs = (args: any): number => {
    let declared = 0;
    if (args && typeof args === "object") {
      const t = args.timeout ?? args.timeoutMs ?? args.timeout_seconds;
      if (typeof t === "number" && Number.isFinite(t) && t > 0) declared = t * 1000;
    }
    const command =
      args && typeof args.command === "string"
        ? args.command
        : typeof args === "string"
          ? args
          : "";
    if (command) {
      // Match `timeout 400` / `timeout 400s` / `(timeout 400s)` and cap at the
      // max occurrence (a chain can carry several staged timeouts).
      const re = /\b(?:timeout|gtimeout)\s*\(?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|minute|minutes)?/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(command))) {
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n <= 0) continue;
        const mult = (m[2] ?? "").startsWith("m") ? 60_000 : 1_000;
        declared = Math.max(declared, n * mult);
      }
      // A bare `sleep 420; ...` chain also declares its own deadline: exactly
      // like `(timeout 420s)`, the command will self-terminate at ~420s and the
      // tool result flows back to the model normally. Without this, a long
      // sleep was treated as an undeclared tool that could hang forever, and
      // the watchdog aborted it at STALL_TIMEOUT_MS (360s) — mid-sleep, before
      // it would have returned on its own. Take the max sleep duration (a chain
      // may stage several sleeps). Note `while true; do sleep 1; done` yields
      // only 1s here, so genuinely infinite loops are still caught at the stall
      // window, exactly as before.
      const sleepRe = /\bsleep\s+(\d+(?:\.\d+)?)\s*((?:s|sec|secs|m|min|mins|minute|minutes|h|hr|hrs|hour|hours))?\b/gi;
      let sm: RegExpExecArray | null;
      while ((sm = sleepRe.exec(command))) {
        const n = Number(sm[1]);
        if (!Number.isFinite(n) || n <= 0) continue;
        const unit = sm[2] ?? "";
        const mult = unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 1_000;
        declared = Math.max(declared, n * mult);
      }
    }
    return declared;
  };

  const stallTick = () => {
    stallLastActivity = Date.now();
  };
  const stallEnd = () => {
    stallActive = false;
    stallCtx = undefined;
    inFlightTools.clear();
  };
  const stallStart = (ctx: any) => {
    if (!stallTimer) {
      stallTimer = setInterval(() => {
        if (!stallActive || !stallCtx) return;
        const elapsed = Date.now() - stallLastActivity;
        // Effective deadline: at least our watchdog window, but wait longer if
        // any in-flight tool declared a longer timeout (it will self-terminate
        // and route its result back to the model).
        let effectiveDeadline = STALL_TIMEOUT_MS;
        if (inFlightTools.size > 0) {
          let undeclaredTool = false;
          for (const info of inFlightTools.values()) {
            if (info.declaredMs > 0) {
              effectiveDeadline = Math.max(effectiveDeadline, info.declaredMs + STALL_TOOL_MARGIN_MS);
            } else {
              undeclaredTool = true;
            }
          }
          // A tool with NO declared timeout has no self-termination safety net;
          // it can hang forever, so we must not extend the deadline for it.
          if (!undeclaredTool) {
            // All in-flight tools declared a timeout: wait for the latest one
            // before even considering intervention.
            if (elapsed <= effectiveDeadline) return;
          }
        }
        if (elapsed <= STALL_TIMEOUT_MS) return;
        // A tool call started but never finished => the agent is blocked on a
        // crashed/hung function. A blind "please continue" steer cannot help
        // (the model is still awaiting that tool). Abort the stuck operation to
        // unblock it, then ROUTE CONTROL BACK TO THE LLM so the model decides
        // what to do next (retry, wait longer, change approach) instead of just
        // stopping.
        if (inFlightTools.size > 0) {
          // Don't loop forever on a tool that keeps hanging: cap the aborts and
          // otherwise stop firing and let the user decide.
          if (hungToolAborts >= HUNG_TOOL_ABORT_CAP) {
            stallCtx.ui?.notify?.(
              `guardrail: tool call(s) keep hanging; gave up after ${HUNG_TOOL_ABORT_CAP} aborts (not looping)`,
              "warn",
            );
            stallEnd();
            return;
          }
          hungToolAborts++;
          const names = Array.from(inFlightTools.keys()).join(", ");
          stallCtx.ui?.notify?.(
            `guardrail: tool call(s) ran past their declared timeout (${Math.round(effectiveDeadline / 1000)}s; ${names}); aborting then asking the LLM how to proceed`,
            "warn",
          );
          // Unblock the stuck tool, then give control back to the model.
          // NOTE: capture ctx BEFORE stallEnd() — stallEnd() nulls the shared
          // stallCtx, so reading it in the resume IIFE below used to throw
          // (TypeError: reading 'waitForIdle' of undefined), which the empty
          // catch swallowed: the "ask the LLM how to proceed" steer never ran
          // and the run just died with the AbortError.
          const ctxToResume = stallCtx;
          const canAbort = typeof ctxToResume?.abort === "function";
          if (canAbort) ctxToResume.abort();
          stallEnd();
          const piAny = pi as any;
          const steer = (piAny.sendUserMessage ?? piAny.sendMessage).bind(piAny);
          void (async () => {
            try {
              if (canAbort) {
                // Wait for the aborted run to settle so the re-prompt starts a
                // fresh turn rather than queueing behind the dead one.
                await ctxToResume.waitForIdle?.().catch(() => {});
                steer(
                  `[guardrail] A tool call (${names}) ran past its allowed time and was interrupted because it hung. Decide how to proceed and continue the task: retry it, wait longer, split it up, or use a different approach. Do not stop.`,
                  { deliverAs: "steer", expandPromptTemplates: false },
                );
              } else {
                // No abort handle: nothing actually stopped, so don't claim we
                // interrupted the call — just surface it.
                ctxToResume?.ui?.notify?.(
                  `guardrail: tool call(s) (${names}) ran past their allowed time but could not be interrupted; leaving the run as-is`,
                  "warn",
                );
              }
            } catch {
              /* no-op: leave control with the user */
            }
          })();
          return;
        }
        // Otherwise the model just produced no output (slow/thinking). Gently
        // re-prompt to resume.
        if (stallRetries >= STALL_RETRY_CAP) {
          stallCtx.ui?.notify?.(
            `guardrail: turn still unresponsive after ${STALL_RETRY_CAP} retries; giving up (no abort)`,
            "warn",
          );
          stallEnd();
          return;
        }
        stallRetries++;
        const piAny = pi as any;
        const steer = (piAny.sendUserMessage ?? piAny.sendMessage).bind(piAny);
        steer(
          "[guardrail] It looks like your previous response stalled (no output for a while). Please continue from where you left off and complete the task — if you were mid-analysis or mid-tool-step, resume that now.",
          { deliverAs: "steer", expandPromptTemplates: false },
        );
        stallCtx.ui?.notify?.(
          `guardrail: turn stalled (no activity for >${Math.round(STALL_TIMEOUT_MS / 1000)}s); injected a resume re-prompt (retry ${stallRetries}/${STALL_RETRY_CAP})`,
          "warn",
        );
      }, STALL_POLL_MS);
    }
    stallActive = true;
    stallCtx = ctx;
    stallTick();
  };

  pi.on("turn_start", async (_event, ctx) => stallStart(ctx));
  pi.on("message_update", async () => stallTick());
  pi.on("tool_execution_start", async (event: any) => {
    if (event?.toolCallId) {
      const declaredMs = declaredTimeoutMs(event.args);
      inFlightTools.set(event.toolCallId, { startedAt: Date.now(), declaredMs });
    }
    stallTick();
  });
  pi.on("tool_execution_update", async (event: any) => {
    if (event?.toolCallId) {
      const cur = inFlightTools.get(event.toolCallId);
      const declaredMs = Math.max(cur?.declaredMs ?? 0, declaredTimeoutMs(event.args));
      inFlightTools.set(event.toolCallId, { startedAt: cur?.startedAt ?? Date.now(), declaredMs });
    }
    stallTick();
  });
  pi.on("tool_execution_end", async (event: any) => {
    if (event?.toolCallId) inFlightTools.delete(event.toolCallId);
    stallTick();
  });
  pi.on("agent_end", async () => stallEnd());
  pi.on("agent_settled", async () => {
    stallEnd();
    stallRetries = 0; // fresh stall budget for the next run
    hungToolAborts = 0; // fresh hung-tool budget for the next run
  });
  pi.on("session_shutdown", async () => {
    stallEnd();
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = undefined;
    }
  });

  // -------------------------------------------------------------------------
  // E) Streamlined file writing for weaker quantized models.
  // -------------------------------------------------------------------------
  // Many quantized models repeatedly try `bash << heredoc` or embedded multi-
  // line `python3 -c "..."`, which the tool-delivery layer collapses into one
  // token -> syntax errors. Instead we (1) inject a system-prompt reminder that
  // file content MUST go through the `write`/`write_files_batch` tools (they
  // preserve raw newlines), and (2) provide a batch tool whose args are a FLAT
  // string (no nested JSON the model can garble) with clear `===FILE:path===`
  // delimiters, so one call writes many files.
  const WRITE_PROMPT_HINT =
    "\n[file writing] To create or edit files, ALWAYS use the `write` tool (single file) " +
    "or `write_files_batch` (many files). Pass file content as the `content`/`content` string " +
    "argument — newlines are preserved exactly. NEVER use `bash << heredoc` or embedded " +
    "multi-line `python3 -c \"...\"` to write source code: the command delivery layer collapses " +
    "newlines into one token and produces syntax errors. After writing a file, you may read it " +
    "back with `read` to confirm.";

  pi.on("before_agent_start", async (event, _ctx) => {
    const base = (event as any)?.systemPrompt as string | undefined;
    if (typeof base !== "string" || base.includes("[file writing]")) return; // already injected
    return { systemPrompt: base + WRITE_PROMPT_HINT };
  });

  const registerBatchWrite = (): void => {
    pi.registerTool({
      name: "write_files_batch",
      label: "Write many files",
      description:
        "Write multiple files in one call. Args is a single flat string where each file is " +
        "delimited by `===FILE:<path>===` ... `===END===` (both on their own lines). Example:\n" +
        "===FILE:src/a.py===\nprint(1)\n===END===\n===FILE:src/b.py===\nprint(2)\n===END===\n" +
        "Parent directories are created automatically. Content keeps its exact newlines.",
      promptSnippet: "Write many files at once via ===FILE:<path>=== blocks",
      promptGuidelines: [
        "When creating several files, use write_files_batch in ONE call (not repeated writes).",
        "Never write source via bash heredocs or embedded python -c; use write/write_files_batch.",
      ],
      parameters: Type.Object({
        content: Type.String({ description: "Flat block of ===FILE:path===/===END=== entries" }),
      }),
      async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
        const cwd = (ctx as any)?.cwd ?? process.cwd();
        const raw = String(params?.content ?? "");
        // Split into path+body pairs on ===FILE:path=== boundaries, then strip
        // the ===END=== terminator (and wrapper newlines) from each body.
        const blocks = raw.split(/===FILE:(.+?)===\n?/g);
        const written: string[] = [];
        const errors: string[] = [];
        for (let i = 1; i + 1 < blocks.length; i += 2) {
          const rel = blocks[i].trim();
          let body = blocks[i + 1].replace(/^\n/, ""); // drop the newline right after ===FILE:path===
          body = body.replace(/\n?===END===\n?$/g, ""); // drop the ===END=== terminator
          body = body.replace(/^\n|\n$/g, ""); // strip leftover wrapper newlines
          const abs = nodePath.resolve(cwd, rel);
          try {
            nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
            nodeFs.writeFileSync(abs, body, "utf8");
            written.push(`${rel} (${body.length} bytes)`);
          } catch (err: any) {
            errors.push(`${rel}: ${err?.message ?? err}`);
          }
        }
        const summary =
          (written.length ? `Wrote:\n${written.join("\n")}` : "No files matched ===FILE:path=== blocks.") +
          (errors.length ? `\nErrors:\n${errors.join("\n")}` : "");
        return { content: [{ type: "text", text: summary }], details: { written, errors } };
      },
    });
  };

  pi.on("session_start", async () => {
    try {
      registerBatchWrite();
    } catch (err: any) {
      console.error("guardrail: write_files_batch registration failed", err);
    }
  });
}
