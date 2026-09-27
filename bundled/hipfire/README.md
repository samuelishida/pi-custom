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
timeout itself fixed rather than a prompt cap, via one of:

- a keepalive proxy in front of hipfire that injects SSE comments (`:keepalive`)
  during the silent prefill, so the client's idle timer keeps resetting;
- a pi transport/fetch with `bodyTimeout` raised (pi accepts `fetch`/`transport`
  options, but nothing in `models.json` wires one up);
- a hipfire-side change to emit periodic progress during prefill (needs a
  rebuild).

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