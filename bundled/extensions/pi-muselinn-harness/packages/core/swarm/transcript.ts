// ============================================================
// Subagent transcript — wire.jsonl 落盘 + 查看器格式化（纯逻辑）。
//
// 只落消息文本与工具名，不落工具参数（Kimi Code wire trace 的
// 参数级记录超出范围）。落盘失败绝不破坏子代理执行：所有 IO 吞错。
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

interface TranscriptPart {
  type: "text" | "toolCall";
  text?: string;
  name?: string;
}

interface TranscriptEntry {
  t: number;
  role: string;
  parts: TranscriptPart[];
  stopReason?: unknown;
  usage?: unknown;
}

/** Narrow an unknown session event to a transcriptable message_end. */
function parseEvent(event: unknown): TranscriptEntry | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "message_end") return null;
  const message = e.message;
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  const role = m.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") return null;
  const parts: TranscriptPart[] = [];
  if (Array.isArray(m.content)) {
    for (const raw of m.content) {
      if (typeof raw !== "object" || raw === null) continue;
      const p = raw as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        parts.push({ type: "text", text: p.text });
      } else if (p.type === "toolCall" || p.toolCallId !== undefined) {
        const name = typeof p.name === "string" ? p.name : typeof p.toolName === "string" ? p.toolName : "unknown";
        parts.push({ type: "toolCall", name });
      }
    }
  }
  const entry: TranscriptEntry = { t: Date.now(), role, parts };
  if (m.stopReason !== undefined) entry.stopReason = m.stopReason;
  if (m.usage !== undefined) entry.usage = m.usage;
  return entry;
}

/**
 * Convert one agent session event into a transcript JSON line, or null
 * when the event carries no transcriptable message. Only message_end
 * events with role user/assistant/tool are recorded; parts map text →
 * { type: "text" } and tool calls → { type: "toolCall", name } (args
 * deliberately dropped).
 */
export function transcriptEventToLine(event: unknown): string | null {
  const entry = parseEvent(event);
  if (!entry) return null;
  return JSON.stringify(entry);
}

/** Sanitized wire.jsonl path for a task under a session dir (同 truncation 模式). */
export function transcriptPathFor(sessionDir: string, taskId: string): string {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${sessionDir}/agents/${safeId}/wire.jsonl`;
}

/** Append one line to the transcript, creating parent dirs. Errors swallowed. */
export function appendTranscriptLine(filePath: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line + "\n", "utf8");
  } catch {
    // 转录失败绝不破坏子代理执行
  }
}

/**
 * Format one stored line for the conversation viewer:
 * `[HH:MM:SS] role: text` or `[HH:MM:SS] assistant → tool: name`.
 * Unparseable lines are returned verbatim.
 */
export function formatTranscriptLine(line: string): string {
  let entry: TranscriptEntry;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) return line;
    const e = parsed as Record<string, unknown>;
    if (typeof e.t !== "number" || typeof e.role !== "string" || !Array.isArray(e.parts)) return line;
    entry = { t: e.t, role: e.role, parts: e.parts as TranscriptPart[] };
  } catch {
    return line;
  }
  const time = new Date(entry.t).toLocaleTimeString("en-GB", { hour12: false });
  const text = entry.parts
    .filter((p): p is TranscriptPart & { text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  if (entry.role === "assistant") {
    const tools = entry.parts.filter((p) => p.type === "toolCall");
    if (tools.length > 0) {
      const names = tools.map((p) => p.name).join(", ");
      return `[${time}] assistant → tool: ${names}`;
    }
  }
  return `[${time}] ${entry.role}: ${text}`;
}
