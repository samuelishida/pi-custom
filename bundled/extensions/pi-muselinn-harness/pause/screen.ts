// ============================================================
// Pause screen — full-screen freeze overlay (adapter, pi-tui).
//
// Engages the process-global AgentPauseGate and renders a
// self-refreshing full-screen overlay (solid dark backdrop +
// centered scene, visual parity with omp's fullscreen pause)
// until the user releases with esc/enter/space/ctrl+c. The
// timer only calls requestRender, so it is harmless after the
// overlay is gone (try/catch).
// ============================================================

import { matchesKey } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { agentPauseGate } from "../packages/core/pause/gate";
import { renderPauseScreen, formatPauseDuration } from "../packages/core/pause/lines";

interface PauseScreenProps {
  theme: { fg(name: string, s: string): string };
  tui: { requestRender(force?: boolean): void; terminal?: { rows?: number; columns?: number } };
  done: (r: { action: "resume" }) => void;
}

export class PauseScreenComponent implements Component {
  private theme: { fg(name: string, s: string): string };
  private tui: { requestRender(force?: boolean): void; terminal?: { rows?: number; columns?: number } };
  private done: (r: { action: "resume" }) => void;
  private timer: NodeJS.Timeout | undefined;

  constructor(props: PauseScreenProps) {
    this.theme = props.theme;
    this.tui = props.tui;
    this.done = props.done;
    // Self-refresh the elapsed-duration line every second.
    this.timer = setInterval(() => {
      try {
        this.tui.requestRender();
      } catch {
        /* overlay gone */
      }
    }, 1000);
  }

  render(width: number): string[] {
    const now = Date.now();
    // Full height: paint every terminal row so the backdrop covers
    // the whole screen (pi's overlay API has no alt-screen/backdrop
    // primitive; a full-height component is the equivalent).
    const rows = this.tui.terminal?.rows ?? 24;
    // Prefer the real terminal width over the overlay's resolved width:
    // a width mismatch leaves an uncovered strip on the right edge.
    const cols = this.tui.terminal?.columns ?? width;
    return renderPauseScreen({
      width: Math.max(1, Math.min(cols, Math.max(cols, width))),
      height: Math.max(1, rows),
      pausedAt: agentPauseGate.pausedAt ?? now,
      nowMs: now,
      pausedOrigin: agentPauseGate.pausedOrigin,
      style: {
        accent: (s) => this.theme.fg("accent", s),
        text: (s) => this.theme.fg("text", s),
        muted: (s) => this.theme.fg("muted", s),
        dim: (s) => this.theme.fg("dim", s),
      },
    });
  }

  invalidate(): void {
    /* stateless render — nothing to invalidate */
  }

  handleInput(keyData: string): void {
    if (
      matchesKey(keyData, "escape") ||
      matchesKey(keyData, "enter") ||
      matchesKey(keyData, "space") ||
      matchesKey(keyData, "ctrl+c") ||
      keyData === "\x03"
    ) {
      this.done({ action: "resume" });
    }
    // All other keys are ignored while paused.
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Engage the pause gate and show the full-screen overlay. Returns false
 * (without pausing) when the host has no interactive UI.
 */
export async function runPauseScreen(ctx: any): Promise<boolean> {
  if (!ctx?.hasUI || !ctx?.ui?.custom) return false;
  if (agentPauseGate.paused) {
    try { ctx.ui.notify?.("Already paused", "info"); } catch { /* ok */ }
    return true;
  }
  agentPauseGate.pause();
  try {
    await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: (r: { action: "resume" }) => void) =>
        new PauseScreenComponent({ theme, tui, done }),
      {
        overlay: true,
        overlayOptions: { width: "100%", anchor: "top-left", margin: 0 },
      },
    );
  } finally {
    const heldMs = agentPauseGate.resume();
    if (heldMs !== undefined) {
      // omp parity: leave a status line in the session stream after
      // releasing, so the resume is visible in the transcript.
      try {
        ctx.ui.notify?.(`已恢复（暂停 ${formatPauseDuration(heldMs)}）— 代理继续运行`, "info");
      } catch { /* notify is best-effort */ }
    }
  }
  return true;
}
