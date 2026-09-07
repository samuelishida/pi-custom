// ============================================================
// Process-global pause gate — ported semantics from musepi-omp
// packages/agent/src/pause.ts (AgentPauseGate). Pure logic:
// no pi/@earendil-works imports, fully unit-testable.
//
// Engaging the gate freezes every agent that polls it at its
// next safe boundary (harness tool-call gate + main agent
// tool_call events) without aborting anything: in-flight tool
// executions run to completion, then every consumer parks until
// resume(). Queued steering/follow-up messages stay queued and
// deliver normally after resume.
//
// A consumer's own AbortSignal still unwinds a parked wait
// immediately (without releasing the gate), so cancelling one
// run never requires resuming the whole process.
// ============================================================

/** Minimal freeze-gate surface consumers consult. */
export interface PauseGate {
  /** True while the gate is engaged. */
  readonly paused: boolean;
  /**
   * Where the freeze was first observed (e.g. "tool_call"), when a
   * parked consumer reported it. Rendered as a context tag by the
   * pause screen. Undefined for manual pauses.
   */
  readonly pausedOrigin: string | undefined;
  /**
   * Park until the gate is released. Resolves immediately when
   * not paused. An abort on `signal` releases only this wait —
   * the gate stays engaged.
   */
  waitUntilResumed(signal?: AbortSignal, origin?: string): Promise<void>;
}

/** Freeze switch shared by every agent scope in the process. */
export class AgentPauseGate implements PauseGate {
  /** Pending while paused; resolved and cleared on resume. */
  #gate: PromiseWithResolvers<void> | undefined;
  #pausedAt = 0;
  #origin: string | undefined;
  #listeners = new Set<(paused: boolean) => void>();

  /** True while the gate is engaged. */
  get paused(): boolean {
    return this.#gate !== undefined;
  }

  /** Epoch ms when the current pause began; undefined when running. */
  get pausedAt(): number | undefined {
    return this.#gate ? this.#pausedAt : undefined;
  }

  /** First park origin observed during this pause (see PauseGate). */
  get pausedOrigin(): string | undefined {
    return this.#gate ? this.#origin : undefined;
  }

  /** Engage the gate. Returns false (and does nothing) when already paused. */
  pause(): boolean {
    if (this.#gate) return false;
    this.#gate = Promise.withResolvers<void>();
    this.#pausedAt = Date.now();
    this.#origin = undefined;
    this.#notify(true);
    return true;
  }

  /**
   * Release the gate, waking every parked loop. Returns the pause
   * duration in ms, or undefined when the gate was not engaged.
   */
  resume(): number | undefined {
    const gate = this.#gate;
    if (!gate) return undefined;
    this.#gate = undefined;
    this.#origin = undefined;
    gate.resolve();
    this.#notify(false);
    return Date.now() - this.#pausedAt;
  }

  /** Subscribe to pause/resume transitions. Returns an unsubscribe function. */
  subscribe(fn: (paused: boolean) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Park until the gate is released. Resolves immediately when not
   * paused. An abort on `signal` releases only this wait — the gate
   * stays engaged — so a cancelled run unwinds while the rest of the
   * process stays frozen.
   */
  async waitUntilResumed(signal?: AbortSignal, origin?: string): Promise<void> {
    // Loop: resume() swaps the gate promise, so a pause re-engaged
    // while a waiter is between awaits must re-park instead of
    // slipping through.
    while (this.#gate) {
      if (signal?.aborted) return;
      if (origin) this.#origin ??= origin;
      const gate = this.#gate.promise;
      if (!signal) {
        await gate;
        continue;
      }
      const abort = Promise.withResolvers<void>();
      const onAbort = () => abort.resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([gate, abort.promise]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  #notify(paused: boolean): void {
    for (const listener of this.#listeners) {
      try {
        listener(paused);
      } catch {
        // Host UI listeners must never break the gate.
      }
    }
  }
}

/** The process-wide gate polled by harness agent scopes. */
export const agentPauseGate = new AgentPauseGate();
