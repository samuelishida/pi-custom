// ============================================================
// Steering drain — prompt 后消费 session.state.steering 队列（纯逻辑）。
//
// pi 0.83.0 的 AgentSession.steer() 在运行时入队，agent loop 在
// 工具调用完成后投递并 drain 队列；prompt() resolve 后残留的队列
// 只能由新一轮 prompt 消费。本 helper 把初始 prompt + 队列 drain
// 包成一次调用，让"steering 注入"对调用方透明。
// ============================================================

/** Minimal session surface needed for steering. */
export interface SteerableSession {
  prompt(text: string, options?: { source?: string }): Promise<void>;
  readonly state?: { readonly steering?: readonly string[] };
}

/**
 * Send the initial prompt, then keep re-prompting with the head of the
 * steering queue until it drains. Throws when the queue stays non-empty
 * past `maxRounds` (default 10) — protects against a pathological loop.
 * If the session exposes no steering state, behaves as a single prompt.
 */
export async function promptWithSteering(
  session: SteerableSession,
  initial: string,
  opts?: { maxRounds?: number; source?: string },
): Promise<void> {
  const source = opts?.source ?? "extension";
  const maxRounds = opts?.maxRounds ?? 10;
  await session.prompt(initial, { source });
  let rounds = 0;
  for (;;) {
    const steering = session.state?.steering;
    if (!steering || steering.length === 0) break;
    if (++rounds >= maxRounds) {
      throw new Error(`steering loop exceeded max rounds (${maxRounds})`);
    }
    await session.prompt(steering[0], { source });
  }
}
