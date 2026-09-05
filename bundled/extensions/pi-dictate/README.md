# pi-dictate 🎤

Dictate into Pi with your microphone. Toggle recording with a shortcut; the transcription is pasted into the editor.

**How it works in one line:** your shortcut (default `Ctrl+q`) starts/stops a 16 kHz mono recording, which is transcribed locally (whisper.cpp) or in the cloud (OpenAI Whisper), then pasted into the Pi editor.

## Quick start

1. **Install the extension** (one time):
   ```bash
   pi install npm:pi-dictate
   ```
   > ⚠️ The `npm:` prefix is required. A bare `pi install pi-dictate` is interpreted as a local folder path and fails with "Path does not exist".

2. **Install a microphone recorder** (one time):
   - **macOS or Linux**: `brew install sox` (Homebrew works on both — on Linux the distro-native alternative is `sudo apt install sox`)

3. **Set up a transcription backend** (pick one — **local is recommended** for privacy and works offline):

   **Recommended: Local (private, offline, free)**
   - Install whisper.cpp: `brew install whisper-cpp` (works on macOS and Linux) or build from [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
   - Download a model (the small `base.en` is a good start; see the [models list](https://huggingface.co/ggerganov/whisper.cpp/tree/main) for better accuracy):
     ```bash
     curl -L -o ~/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
     export WHISPER_MODEL_PATH=~/ggml-base.en.bin
     ```

   **Alternative: Cloud (OpenAI Whisper)** — requires an API key and sends audio to OpenAI:
   ```bash
   export OPENAI_API_KEY=sk-...
   ```

4. **Restart Pi.** On startup you should see:
   ```
   [voice] Voice input extension loaded (Ctrl+q)
   [voice]  • Recorder: sox
   [voice]  • Backend: 🏠 local STT    (or ☁️ cloud STT)
   ```

5. **Dictate**: press `Ctrl+q` to start, speak, press `Ctrl+q` again. The text is pasted into the editor.

## Troubleshooting

| You see | Meaning | Fix |
|---|---|---|
| `Path does not exist: .../pi-dictate` | Installed without the `npm:` prefix | `pi install npm:pi-dictate` |
| `Backend: ⚠️ no STT configured` | No transcription backend set | Configure one in step 3, restart Pi |
| Crash: `spawn sox ENOENT` at startup | You ran a very old pre-1.0.2 build | `pi uninstall npm:pi-dictate && pi install npm:pi-dictate` |
| Mic permission prompt / silence | OS microphone permission | Grant microphone access to your terminal app |

## Updating

```bash
pi update npm:pi-dictate
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_INPUT_SHORTCUT` | `Ctrl+q` | Toggle key, e.g. `"Ctrl+k"` |
| `STT_BACKEND` | auto | Force `local` or `cloud` (auto prefers local if available) |
| `WHISPER_MODEL_PATH` | auto-discovered | Path to a whisper.cpp `.bin` model |
| `WHISPER_LANGUAGE` | `auto` | Language hint, e.g. `"it"`, `"fr"` |
| `OPENAI_API_KEY` | — | Enables the cloud (OpenAI Whisper) backend |
| `DEBUG_VOICE` | off | Set to `1` for verbose startup/log output |

## Requirements

- **Node.js 18+** (ships with Pi)
- **Recorder**: `sox` or `ffmpeg` (sox recommended)
- **Microphone permissions** in your OS
- Local STT: `whisper-cpp` + a downloaded model
