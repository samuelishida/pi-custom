# hipfire + pi long-session failures

## Context

pi driving `hipfire serve` (qwen3.8:27b-mq4-xt, 163840 ctx) kept dying in long
sessions. Four *different* faults produced overlapping-looking symptoms, so each
"fix" appeared not to work until the next one was found. This records what each
one actually was, how it was distinguished, and what fixed it.

Symptom -> cause -> fix:

| symptom in pi | real cause | fix |
|---|---|---|
| `503 serve queue wait exceeded` | pi's memory agent (hermes-memory) resolved review/flush completions to the **session model**, i.e. hipfire's single admission lane, so a background review blocked the foreground turn | dedicated `memllm` provider on ollama for memory work (`llmModelOverride`) |
| `stopReason=error "terminated"`, `input=0/output=0`, empty content, then `Aborted after N retry attempts` (mid-think) | `reasoning.max_tokens` **equalled** `generation.max_tokens` (4096/4096), so the forced `</think>` close had no budget to emit; hipfire failed **closed** (`rolled_back=true`) and dropped the stream with no error body | keep the per-turn budget far above the think cap (now 65536 vs 16384) |
| same `terminated` symptom but **later** in a session, near ~110k context | cold prefill silence exceeded **undici's 300s `bodyTimeout`** (pi's client; not configurable from pi), so pi killed a connection that was still working | hipfire-side prefill keepalive patch (below) |

Telling the second and third apart matters: both surface as `terminated` with
zero usage. The discriminator is **where** in the session it happens (mid-think
at any context vs. only once the prompt is large) and whether hipfire logged a
validation failure (`open think span at end of generation`) or nothing at all.

## Hardest decision

Not shrinking the prompt. The obvious mitigation was to cap pi's context
(compact at ~80k) so a prefill always finishes inside 300s. That was implemented,
shipped, and then **deliberately removed** in favour of fixing hipfire, because
the cap silently threw away usable context to work around a server-side defect
that was cheap to fix properly.

The measurement that decided it:

```
cold prefill vs prompt size    20k ->  17s
                               60k ->  85s
                               90k -> 207s
                              120k -> past 300s
t ~= 2.56e-8 * n^2   =>  300s at ~108k tokens
```

`undici`'s 300s `bodyTimeout` is the hard wall, and it is reachable only from an
idle-between-chunks gap -- which is exactly what a silent prefill is. So the fix
that generalises is to make hipfire emit something during prefill, not to make
pi ask for less.

That also required realising the compaction line was **not** controlled by
`~/.pi/agent/settings.json`. A user extension (`guardrail.ts`) computes its own
line and cancels pi's built-in threshold compaction via `session_before_compact`
-- so editing `settings.json` did nothing while that extension was loaded. Its
formula was `reserve = min(32768 + 0.531*(window-122880), window*0.2847)`; for a
163840 window that put the line at ~109k, i.e. *inside* the cliff.

Current lines: 122880 -> 90,112 | 147456 -> 105,475 | 163840 -> 117,195 |
262144 -> 187,512 | 1048576 -> 750,046.

## Alternatives rejected

- **Cap the prompt (compact at 80k).** Shipped first, then reverted: it trades
  away context permanently to dodge a bug that only needs ~15 bytes/15s to fix.
- **A keepalive proxy in front of hipfire.** Works with no rebuild, but adds a
  process that must be supervised, and every client gets the fix twice.
- **A pi transport with `bodyTimeout` raised.** pi accepts `fetch`/`transport`,
  but nothing in `models.json` wires one up, so it needs an extension anyway and
  would only fix pi -- not curl, not any other client.
- **Patching the OpenAI SDK / global fetch in pi.** Same objection, plus it
  breaks under SDK updates.
- **Blindly raising `serve.queue_timeout_ms`.** It converts a visible 503 into a
  longer invisible stall; the real problem was contention on a single lane.

## What actually shipped

- **hipfire source change** -- `prefill-keepalive.patch` adds a
  `PrefillHeartbeat` to `crates/hipfire-cli/src/serve/http.rs` that writes
  `: keepalive\n\n` SSE comment frames every 15s for the life of the request.
  Comments are discarded by conforming parsers (the OpenAI SDKs use
  `eventsource-parser`), so output is unchanged while the client's idle timer
  keeps resetting. The task holds a sender clone and the response body only ends
  once every sender is dropped, so it is wrapped in a guard that aborts on
  `Drop`, and that guard is moved into the completion closure -- a finished or
  panicking request can never hold the response open.
- **Budgets** -- `~/.hipfire/config.toml`: `[reasoning] max_tokens = 16384`,
  `[generation] max_tokens = 65536`; pi's `models.json` hipfire entry carries
  `maxTokens: 65536` and `contextWindow: 163840`. Invariant to preserve:
  `reasoning.max_tokens` << `generation.max_tokens`, never equal.
- **Fork** -- `../hipfire`, branch `pi-custom`: `ad10b3d` (upstream tip) plus
  `2de3901` (DFlash adaptive block size) and `f4d0906` (the keepalive fix).
  `master` is left pristine and `upstream` points at `warpfront/hipfire`.
- **Installer** -- `PiCode/scripts/apply-hipfire-prefill-keepalive.sh`
  (apply + build + install; `--check` exits 1 on drift). It stops the service
  before installing because a running `hipfire` holds the binary inode
  (`ETXTBSY`), and backs up the previous binary as `hipfire.bak-keepalive-<ts>`.

## Debugging techniques worth keeping

- **`usage input=0/output=0` + empty content means the stream died mid-flight.**
  It is not a model or prompt problem. Compare pi's `stopReason`/`errorMessage`
  and `responseId` against hipfire's log before touching config.
- **The server's own log is ground truth for "working vs stuck".** A long silent
  prefill leaves no lines at all; a real failure leaves one. `serve.log` has no
  arrival logging (`http.rs` has only two `eprintln!`), so absence of a line
  means nothing on its own.
- **`[daemon-control] received commit` is NOT reliably logged.** Requests that
  demonstrably ran had no commit line. Do not infer "never committed" from it.
- **`[qwen-cache resume ...]` is only logged on a *partial* cache hit**, so a
  fully cold prefill logs nothing either.
- **Measure prefill as a function of prompt size** before blaming anything else;
  the super-linear curve is what identifies a timeout cliff.
- **`strings` cannot confirm the keepalive patch.** LLVM materialises the
  13-byte constant as immediate stores rather than a `.rodata` blob. Verify
  behaviourally: capture a request longer than 15s and count `^: keepalive`.
- **A guardrail extension can own compaction.** Before tuning
  `settings.json`, check which extension is loaded and whether it returns
  `{ cancel: true }` from `session_before_compact`.
- **`/reload` does not always pick up extension edits.** Confirm behaviour
  changed (e.g. the guardrail's own notification line) rather than assuming.

## Least confident

- **The keepalive patch is not yet behaviourally verified.** It compiles, is
  installed, and the fork matches the running source, but the on-the-wire
  `^: keepalive` count was never confirmed -- the probe was killed early. Treat
  it as unproven until a >15s capture shows comment frames.
- **Whether hipfire honours `[reasoning] max_tokens = 16384` is unverified.**
  hipfire *drops* a config `reasoning.max_tokens` for effort-native reasoning
  contracts ("use reasoning_effort only"), and its built-in ladder is
  `low=512, med=2048, high=8192, xhigh=24576, max=32768`. pi's
  `thinkingLevelMap` maps `high`, `xhigh` and `max` all to `"medium"`, so if
  effort is in control the thinking budget is 2048 regardless of the config.
- **No long soak.** The keepalive's interaction with cancellation, client
  disconnects, and continuous batching has not been exercised for hours.

## Reuse

Read before changing: `~/.hipfire/config.toml`, `~/.pi/agent/models.json`,
`~/.pi/agent/settings.json`, `~/.pi/agent/extensions/guardrail.ts`,
`PiCode/bundled/hipfire/*`, or anything about long-session `terminated` /
`503` failures on the pi + hipfire stack.

## Loader wedge: the busy-wait on a lost GPU completion (2026-09-27)

Symptom: the daemon stops making progress mid-load at an arbitrary layer
(62/64, 49/64, 48/64, 44/64, 33/64 all observed), holding 11-15G VRAM, model
stuck at null, GPU idle. `/proc/<pid>/io` shows rchar and read_bytes FROZEN --
not even page-cache reads -- so the loader is not reading the model file, and
neither is it blocked: `ps` says `Rl` at 60-126% CPU.

The decisive evidence came from thread wait channels (readable without ptrace):

    tid 2386536  R  daemon  0                    <- main thread, wchan 0
    tid 2386544  S  daemon  kfd_wait_on_events
    tid 2386545  S  daemon  kfd_wait_on_events
    tid 2386557  S  daemon  anon_pipe_read

`wchan 0` on a running thread means it is spinning in userspace, not sitting in
a syscall. The two `kfd_wait_on_events` threads are HSA signal waits
(`hsa_signal_wait_scacquire`, crates/hsa-bridge/src/lib.rs:389) blocked on the
AMD KFD driver. So the loader is polling for GPU completion of a layer's work
while the driver never delivers that completion. The GPU is idle, so the work
is not slow -- the event is lost.

Do NOT waste time looking for this in the Rust sources as a spin loop: the
userspace spin lives inside the HSA/ROCm runtime, and the missing signal never
appears in hipfire's own code. It is a driver/runtime-level failure. Recovering
requires restarting the process; a bounded timeout on the load's GPU wait (or a
driver-level reset) would be the real fix and is a fork-level project.

Because the wedge is timing-dependent it is flaky, and it got *more* frequent
over a day of repeated load/unload cycles, so a service that reloads its model
often is much more exposed than one that loads once and stays resident. That is
the real argument for `--idle-timeout 0` plus a prewarm: not VRAM, but the fact
that every load is a fresh chance to lose an event.

Operational answer (shipped): a systemd timer runs hipfire-watchdog.sh every
60s. It detects the wedge as R state + frozen I/O + frozen log, confirmed by a
second sample in the same run, then does a clean restart (stop, wait for VRAM to
drop, start). It also retries a FAILED unit but never starts a deliberately
stopped one, so the hipfire-lifecycle extension can still free the GPU, and it
warms the model only when idle with no load in progress (never during a load --
a duplicate request mid-load is itself a plausible trigger for the cancel/
reload cycle that leaves the daemon wedged).
