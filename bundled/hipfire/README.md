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
   daemon in R state with I/O AND log frozen across a 30s window, confirmed by
   a second 20s sample in the same run -- then does a CLEAN restart (stop, wait
   for the GPU to release the VRAM, start), with a 120s backoff so it never
   thrashes. Observed detection-to-recovery: ~50s, VRAM back to 26 MiB before
   the new load starts.

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

## When every load wedges: reset the GPU

The watchdog heals occasional loader wedges by restarting the unit. On
2026-09-27 the failure mode escalated: after ~17:43 **every** qwen3.8:27b-mq4-xt
load wedged (24+ in a row) while a manual 9b load in the same session completed
fine, and restarting hipfire stopped helping. That is driver-level state, not
hipfire state, and no amount of restarting clears it.

Two A/B tests ruled out the obvious hipfire-side suspects:

* DFlash speculation off (`HIPFIRE_SPECULATION=off`, `HIPFIRE_DFLASH_MODE=off`,
  so no draft model at all) -- still wedged.
* `HIPFIRE_GFX11_MQ4V2_IU4=1` removed (the gfx11 iu4-direct MMQ kernel select,
  the one unit env var the working manual 9b run did not have) -- still wedged.

The display on this box is on the Intel iGPU (card1, vendor 0x8086), so the AMD
card (card2, vendor 0x1002) is compute-only and can be reset **without touching
the desktop session**:

```sh
systemctl --user stop hipfire                      # release /dev/kfd + renderD129
echo 1 | sudo tee /sys/class/drm/card2/device/reset
journalctl -k -n 20 | grep -i amdgpu               # confirm the reset happened
systemctl --user start hipfire
```

If the sysfs reset is unavailable or does not take, reload the module instead
(nothing but hipfire holds the AMD device):

```sh
systemctl --user stop hipfire
sudo modprobe -r amdgpu && sudo modprobe amdgpu
systemctl --user start hipfire
```

The watchdog gives up after `MAX_WEDGES_IN_A_ROW=3` consecutive wedges without a
completed load, backs off for 10 minutes, and raises a desktop notification
naming this recipe -- an endless restart loop would thrash the GPU and hide the
cause.

## Two models, per-model policy (qwen3.8:27b-mq4-xt and qwen3.6:35b-a3b-mq4r)

Only one model fits in 25.75 GB, so the served model is chosen by the unit's
`ExecStart` and everything model-specific lives in `~/.hipfire/models.toml`.

| | `qwen3.8:27b-mq4-xt` | `qwen3.6:35b-a3b-mq4r` |
|---|---|---|
| artifact | 14.99 GB, MQ4G256V2 (qt44), dense | 18.70 GB, MQ4G256 (qt13), MoE 35B/3B-active |
| `memory.max_seq` | 163840 (160K) | 131072 (128K) |
| `memory.kv_cache` | q8 | q8 |
| `speculation.mode` | `dflash` (+ `dflash = auto`) | `mtp` (+ `mtp = on`, `mtp_k = 3`) |
| drafter source | registry sidecar `qwen38-27b-dflash-mq4.hfq` | sibling `qwen3.6-35b-a3b.mtp` |
| registry tag | `qwen3.8:27b-mq4-xt` | `qwen3.6:35b-a3b-mq4r` |

### Why the unit no longer pins speculation

An `Environment=` line in the unit **beats per-model config for every model the
unit serves**. The unit used to pin `HIPFIRE_SPECULATION=dflash`, so switching it
to the 35B would have forced dflash, found no dflash sidecar, and fallen back to
plain AR with only a log warning -- MTP would silently never engage. The three
spec env vars are now commented out in the unit as a bisect lever only.

Two corrections that came out of this: the old comment claimed the registry had
no draft sidecar for `qwen3.8:27b-mq4-xt` (it does -- sha256 `d0a74a23...`), so
the explicit `HIPFIRE_DFLASH_DRAFT` path was always redundant; and
`HIPFIRE_QWEN35_MTP` / `HIPFIRE_QWEN_MTP` appear in `docs/env-vars.md` and the
speculation inventory but **do not exist in the source** -- the real gate is
`mtp_mode` (`crates/hipfire-generate/src/ar.rs:5399`) plus `mtp_weights_present`,
which the loader sets from the `.mtp` sidecar it finds at
`trunk_path.with_extension("mtp")` with no flag at all.

### MTP notes (qwen3.6:35b-a3b-mq4r)

* The 0.47 GB `.mtp` sidecar is pulled automatically ("Fetching MTP sidecar").
  The serve log confirms it with `MTP head loaded (sidecar ...): n_embd=...`.
* `p_min` (acceptance floor) selects **0.6 on gfx1100/gfx1101/gfx1102** versus
  0.0/off elsewhere, so on the 7900 XTX MTP is genuinely active rather than a
  no-op. Override with `HIPFIRE_MTP_P_MIN`.
* `HIPFIRE_MTP_PROPOSAL_GRAPH` stays OFF on purpose: token-identical but
  measured neutral/slightly negative on the A3B K=5 smoke (192.99 tok/s unset vs
  191.44 graph=on, same output md5).
* 128K is **advertised, not proven** for this artifact: there is no B/token
  measurement for it (the 27B's is ~42,200 B/token), and `min_vram_gb` is 22.0
  against 25.75 GB usable. The overrun signature is the clean
  `prefill: HipError(2): hipMemCreate: out of memory`, not a loader wedge.

### Switching the served model

```sh
# 1. stop, which also frees the VRAM the other model is holding
systemctl --user stop hipfire
# 2. point ExecStart at the other tag, then start
sed -i 's/hipfire serve [^ ]*/hipfire serve qwen3.6:35b-a3b-mq4r/' \
    ~/.config/systemd/user/hipfire.service
sed -i 's/^default_model = .*/default_model = "qwen3.6:35b-a3b-mq4r"/' ~/.hipfire/config.toml
systemctl --user daemon-reload && systemctl --user start hipfire
```

`config.toml`'s `serve.default_model` is pinned too, so a bare `hipfire serve` /
`hipfire restart` resolves the same tag as the unit. `--kv-mode q8` on the
ExecStart line stays: both models want q8, and it agrees with the per-model
`memory.kv_cache`.

In pi, pick the matching `hipfire` model in the picker -- pi sends the model id
in the request, so a mismatch means the daemon loads a different model than the
one you selected. The hotswap extension only owns the hipfire-vs-other-provider
transition, not hipfire-model-vs-hipfire-model.

### How a model switch actually works

`systemctl --user stop hipfire` is the *leave* path (it frees the GPU for
ollama). Switching between the two hipfire models is a different operation and
does not restart the service:

```sh
~/.hipfire/bin/hipfire-use-model.sh qwen3.6:35b-a3b-mq4r   # makes this one resident
~/.hipfire/bin/hipfire-use-model.sh                        # (no arg) prints usage
/home/smk/.hipfire/bin/hipfire-use-model.sh qwen3.8:27b-mq4-xt
```

It does two things:

1. writes `serve.default_model` in `~/.hipfire/config.toml` (one line, backed up,
   comments preserved), so any later start prewarms the selected model instead of
   drifting back to the old one;
2. makes that model resident -- if the unit is inactive it starts it, and if the
   unit is active it fires one 1-token request for the tag.

Step 2 works because of `ServeRuntime::ensure_model`
(`crates/hipfire-cli/src/serve/mod.rs:1114`): it computes
`must_reload = self.current_path != Some(&path)` from the **request's** model
field and loads that model with its own per-model config
(`resolved_for_model`). So `qwen3.6:35b-a3b-mq4r` requested while the 27B is
resident unloads the 27B and loads the 35B in place. (If the tag is not local at
all, `ensure_model` even calls `pull_command` first.)

**Why not `systemctl restart`:** an in-daemon reload avoids handing port 11435 to
a fresh serve while the GPU is still releasing the old model -- the race that
produces loader wedges. And if the load *does* wedge, the watchdog's clean
restart prewarms `serve.default_model`, i.e. the model just selected, so the heal
lands on the intended model instead of fighting it.

Exit codes: `0` resident, `2` still loading at the deadline, `3` loader wedged
(hand off to the watchdog), `1` error. The pi extension
(`hipfire-lifecycle`) calls this script for both "entering hipfire" and
"hipfire -> hipfire on a different tag"; the latter used to be skipped entirely
with `skip (no hipfire transition)`, which left pi asking for a model the daemon
was not serving.

Verified 2026-09-27: `serve.default_model` = `qwen3.6:35b-a3b-mq4r`, the 35B came
up resident, and its load log shows the configuration actually applied:

```
MTP head loaded (sidecar /media/smk/Models/hipFire/qwen3.6-35b-a3b.mtp): n_embd=2048 vocab=248320
KV cache: Q8 vmm (10/40 layers carry KV; mapped_prefix=3855 / physical_cap=131072 / max_seq=131072)
[redline] enabling fail-closed retained default on gfx1100 (model_arch=qwen3_5_moe, drafter=mtp, transport=pm4)
weight sweep: 91826 ms      VRAM 20.24 / 25.75 GB
```

### Other clients

* **pi**: `~/.pi/agent/models.json` carries both hipfire entries (163840 and
  131072 context). Pick the matching one; pi sends the id in the request, and a
  mismatched id makes hipfire try to *pull* that name rather than switch.
* **VS Code / Continue**: `~/.continue/config.yaml` has both entries as
  `provider: openai` with `apiBase: http://127.0.0.1:11435/v1`.
* **Codex: not possible without a proxy.** `codex-cli >= 0.156` removed
  `wire_api = "chat"` (the binary contains `` `wire_api = "chat"` is no longer
  supported. ``) and hipfire serve exposes no `/v1/responses` -- its routes are
  `/health`, `/metrics`, `/stats`, `/v1/models`, `/v1/chat/completions`,
  `/v1/images/{generations,edits}`. The unit's config therefore keeps its
  hipfire provider block commented out (that was already discovered on
  2026-09-24). Using hipfire from codex needs a Responses->chat translating
  proxy in front of 11435.
* **VS Code / deepseek-copilot**: `deepseek-copilot.baseUrl` still points at
  `http://127.0.0.1:8000/v1`, which was vLLM and is no longer installed, and its
  `modelIdOverrides` all name `qwen3.8-27b-ad`, the vLLM served name. To revive
  it, point the baseUrl at hipfire and use a tag hipfire actually serves.
