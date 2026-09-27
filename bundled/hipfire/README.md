# hipfire server + model setup

The hipfire side of this machine's local-inference setup: the server's
`config.toml`, the systemd unit, and the `models.json` that declares the
hipfire provider to pi.

These live outside `~/.pi/agent`, so `preinstall-bundle.sh` does not manage
them. Use `scripts/install-hipfire-stack.sh` instead.

| File | Installs to |
|---|---|
| `config.toml` | `~/.hipfire/config.toml` |
| `hipfire.service` | `~/.config/systemd/user/hipfire.service` |
| `models.json` | merged into `~/.pi/agent/models.json` |

## The one rule that matters

**`reasoning.max_tokens` (the thinking cap) must stay comfortably below
`generation.max_tokens` (the per-turn budget). Never let them be equal.**

When thinking reaches `reasoning.max_tokens`, hipfire force-closes the
` thinking` block, and that closing tag costs generation budget. If the
per-turn budget is already exhausted, the close cannot be emitted:

- the turn ends *inside* ` thinking`
- validation reports `open think span at end of generation (validation)`
- the daemon fails **closed** (`rolled_back=true`): the entire response is
  discarded and the HTTP stream is dropped, with no error body

Measured with the same prompt and the same 200-token think cap:

```
max_tokens=200   -> SocketError: other side closed   (no finish_reason)
max_tokens=1200  -> completes normally
```

and at the values this bundle used to ship (`4096` and `4096`):

```
max_tokens=4096  -> 53.9s of streaming, then the socket closed
```

### Client-visible symptoms

pi reports `stopReason=error`, `errorMessage="terminated"`, and
`usage.input=0 / output=0` with **empty content** (the rollback discards
everything), twice, then `stopReason=aborted` with
`Aborted after 2 retry attempts`. Because the failure is deterministic, retries
re-run it identically, which makes it look like a flaky network problem rather
than a configuration collision.

### Why the budget has to come from two places

`generation.max_tokens` is used when the request omits `max_tokens`, and pi
omits it unless the model entry declares `maxTokens`. So the budget is set on
both sides:

- `config.toml` -> `[generation] max_tokens = 65536` (covers any client)
- `models.json` -> the hipfire model entry's `"maxTokens": 65536` (so pi always
  states it)

pi clamps this to `contextWindow - estimatedContext - 4096`, so the effective
budget shrinks as a session grows. Auto-compaction keeps it far above the
think cap (16384), but if the think cap is ever raised, raise the budget too.

The per-turn budget does **not** interact with the 300s client timeout: during
generation tokens stream continuously, so undici's idle-between-chunks timer
keeps resetting. That timer only bites during **prefill**, when hipfire emits
nothing (see below). What governs the prompt size is pi's compaction line, which
the guardrail extension computes from `contextWindow`.

## Cold-prefill cliff (the 300s client timeout)

hipfire emits one SSE chunk immediately and then stays silent for the whole
prefill. pi's HTTP client (undici) aborts a stream that goes 300s without a
chunk, and that 300s is undici's default `bodyTimeout` -- not a hipfire limit
and not user-exposed. Measured cold prefills: 20k tok -> 17s, 60k -> 85s,
90k -> 207s, 120k -> never returned. Fitting `t ~= 2.56e-8*n^2` puts 300s at
**~108k tokens**, so any prompt above that dies deterministically as
`terminated` with zero content, and every retry re-runs the same cold prefill
and dies identically.

The guardrail no longer special-cases hipfire, so its line for a 163840 window
is **~117k** -- above the cliff. Long hipfire sessions therefore need the
timeout itself fixed rather than a prompt cap. Three ways, in order of
preference:

1. **hipfire emits keepalives during prefill** -- IMPLEMENTED, see
   `prefill-keepalive.patch` below. Fixes it for every client.
2. **a proxy in front of hipfire** that injects the same SSE comments on the
   wire. No rebuild, but adds a process to keep running.
3. **a pi transport/fetch with `bodyTimeout` raised** (pi accepts
   `fetch`/`transport` options, but nothing in `models.json` wires one up).

## `prefill-keepalive.patch` (hipfire source change)

`hipfire serve` writes the role chunk to the SSE stream immediately and then
nothing until the first generated token, so a cold prefill leaves the connection
byte-silent for minutes -- which is exactly what trips a client's idle timeout.
The patch adds a `PrefillHeartbeat` to
`crates/hipfire-cli/src/serve/http.rs` that writes `: keepalive\n\n` SSE comment
frames every 15s for the life of the request.

- Comment frames are discarded by conforming SSE parsers (the OpenAI SDKs use
  `eventsource-parser`), so model output is byte-for-byte unchanged.
- 15s sits under undici's 300s `bodyTimeout` *and* nginx's 60s
  `proxy_read_timeout`, at ~15 bytes per tick.
- The task holds a sender clone and the response body only ends once every
  sender is dropped, so the heartbeat is wrapped in a guard that aborts on
  `Drop`, and that guard is moved into the completion closure -- a finished or
  panicking request can never hold the response open.

The patch is against `ad10b3d97cedc8ac156c2e8bc2f2e21735ce4de6` (verified to
apply to a pristine checkout of that commit) and only touches that one file
(+61 lines, no deletions).

Apply, build, and install with:

```sh
scripts/apply-hipfire-prefill-keepalive.sh              # apply + build + install
scripts/apply-hipfire-prefill-keepalive.sh --check      # drift check (exit 1)
```

It stops the service before installing, because a running `hipfire` holds the
binary's inode (`ETXTBSY` otherwise), and backs up the previous binary as
`hipfire.bak-keepalive-<ts>`.

Verify behaviourally -- `strings` will NOT show the keepalive literal, because
LLVM materialises the 13-byte constant as immediate stores rather than a
`.rodata` blob. Capture a request that runs longer than 15s and count the
comment frames:

```sh
curl -sS -N --data-binary @probe.json -H 'Content-Type: application/json' \
     http://127.0.0.1:11435/v1/chat/completions | grep -c '^: keepalive'
```

Guardrail lines at the current formula (`reserve = min(32768 + 0.531*(window -
122880), window * 0.2847)`):

| window | compaction line |
|---|---|
| 122,880 (Qwen 27B ollama base) | 90,112 |
| 147,456 | 105,475 |
| 163,840 (hipfire) | 117,195 |
| 262,144 | 187,512 |
| 1,048,576 (deepseek 1M) | 750,046 |

## Notes

- hipfire's config keys are Process-scope: `config.toml` changes need
  `systemctl --user restart hipfire`.
- `hipfire.service` pins `--idle-timeout 600` (10 min). After that the model
  unloads, and the next request reloads 64 layers from disk and cold-prefills
  the whole context because the prefix cache went with it. `0` disables the
  unload entirely (the watcher thread is gated on
  `if !shared.idle_timeout.is_zero()`); the trade-off is VRAM stays held, which
  conflicts with running a local ollama model alongside.
- `models.json` here uses placeholder API keys only (`hipfire`, `ollama`, ...)
  for local endpoints. Real credentials belong in `auth.json` / environment
  variables, never in this file.
- The `pi-token-speed` style display value `recent_tok_s` from `/stats` is a
  recent-window figure that a reload or an aborted request drags down; measure
  with a controlled short request instead of trusting it.

## Local hipfire fork

The hipfire source itself is forked at `../hipfire` (sibling of this repo), since
the prefill keepalive is a source change and not a config one:

- `master` -- pristine upstream tip (`ad10b3d`, remote `upstream` =
  `https://github.com/warpfront/hipfire.git`)
- `pi-custom` -- `2de3901` DFlash adaptive draft block size, then `f4d0906` the
  prefill keepalive fix

Both working-tree states are reproduced byte-for-byte from the tree this machine
runs. Rebuild and install from there with
`scripts/apply-hipfire-prefill-keepalive.sh` (which applies the same patch to
`~/.hipfire/src`), or build the `pi-custom` branch directly.

See `.agents/learnings/hipfire-pi-long-session-failures.md` for the full
symptom -> cause -> fix record across all four faults.

## Lifecycle: preclean + watchdog

Two operational failure classes were observed on this box (2026-09-27), both
making `hipfire serve` unavailable until a human intervened:

1. **Start races.** After a stop, the reaped daemon pid can linger briefly as
   a zombie; `kill -0` succeeds on a zombie, so a fresh start dies with
   `FATAL: hipfire daemon already running (PID N)` and the unit lands in
   `failed`. `serve-preclean.sh` (ExecStartPre) now covers BOTH pid records
   (`daemon.pid` and `serve.pid`), verifies the pid really belongs to hipfire
   before killing (pid reuse must not kill an unrelated process), waits for the
   pid to fully disappear from `/proc` rather than merely get signalled, frees
   the port, and drops the stale records.

2. **Loader wedges.** Twice in one day the daemon's main thread spun at
   ~100-126% CPU with zero disk I/O, GPU idle, log frozen mid-layer (62/64 and
   44/64), model stuck at null, holding 11-15G of VRAM. `hipfire-watchdog.sh`
   (run every 60s by `hipfire-watchdog.timer`) detects that signature --
   daemon in R state with I/O AND log frozen across a 30s window, twice in a
   row -- and restarts the unit, with a 300s backoff so it never thrashes.

The watchdog also retries a `failed` unit (reset-failed + start) but NEVER
starts an inactive one: the hipfire-lifecycle extension stops the unit
deliberately to free VRAM, and the watchdog must not fight that.

It warms the model when the unit is up, idle, and the model is null, so the
first user request pays no ~90s load inside admission (where no response
headers exist yet and nothing can keep a client alive).

`--idle-timeout 0` (in hipfire.service) removes the mid-session
unload/reload churn -- 25 idle unloads are recorded in serve.log, and each
reload is a fresh opportunity for the loader wedge. The cost is that VRAM
stays held while hipfire runs; that is fine here because the pi memory route
(memllm) uses a cloud model and hipfire-lifecycle still stops the unit on
model switch.

Watchdog log: `~/.hipfire/watchdog.log`.
