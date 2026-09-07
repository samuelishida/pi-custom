// ============================================================
// TUI — spinner keep-alive gate (pure, no pi imports).
//
// pi-tui re-renders the WHOLE component tree per frame, which at high
// context costs real milliseconds (a large session can take 20-100ms per
// full-tree render). The border spinner + shimmer sweep ride on pi's
// natural renders (wall-clock frame/band selection in the slot builder);
// the keep-alive timer exists solely to cover quiet gaps (long tool
// executions with no streaming).
//
// The cadence is deliberately conservative: a 200ms quiet threshold + 100ms
// timer caps forced renders at ~10fps, so a stalled agent loop costs at most
// ~10 full-tree renders per second instead of hogging the event loop at
// 25fps (observed: whole-TUI lag on ~800k-context sessions). While pi
// renders naturally (streaming deltas, tool bursts — typically >>10fps) the
// gate skips the forced render entirely, so active phases cost nothing.
// ============================================================

/** Minimum quiet period before a keep-alive render is forced (ms). */
export const KEEP_ALIVE_QUIET_MS = 200;

/** Keep-alive timer cadence (ms) — ~10fps ceiling for the spinner/shimmer. */
export const KEEP_ALIVE_INTERVAL_MS = 100;

export function shouldKeepAliveRender(working: boolean, lastRenderAt: number, now: number): boolean {
  return working && now - lastRenderAt >= KEEP_ALIVE_QUIET_MS;
}

/** Wall-clock spinner frame index: advances on any render, no state. */
export function wallClockFrameIndex(frameCount: number, now: number, frameIntervalMs: number): number {
  if (frameCount <= 0) return 0;
  return Math.floor(now / frameIntervalMs) % frameCount;
}
