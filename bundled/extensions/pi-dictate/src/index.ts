// Pi Voice Input Extension
// Dictate text into the editor using your microphone.
// Shortcut: Ctrl+q to start/stop recording.
//
// Dependencies (pick one):
//   sox     — brew install sox   /  apt install sox
//   ffmpeg — brew install ffmpeg   /  apt install ffmpeg
// For cloud transcription: set OPENAI_API_KEY environment variable.
// For local transcription: install whisper-cpp and download a .bin model:
//    macOS: brew install whisper-cpp
//   Linux: See https://github.com/ggml-org/whisper.cpp
// Then download a model, e.g.:
//    curl -L -o ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
// Set WHISPER_MODEL_PATH=/path/to/ggml-base.en.bin to use local transcription.
// Or set STT_BACKEND=local | cloud | any (default: auto-detects)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import OpenAI from "openai";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

// ── Configuration ────────────────────────────────────────────────
// Override via env var (e.g. VOICE_INPUT_SHORTCUT="Ctrl+o")
const RECORDING_SHORTCUT = process.env.VOICE_INPUT_SHORTCUT ?? "Ctrl+q";

function log(msg: string) {
	if (process.env.DEBUG_VOICE) console.log(`[voice] ${msg}`);
}
const AUDIO_RATE = 16000;    // 16kHz mono is optimal for Whisper
const AUDIO_CHANNELS = 1;

/** Discover local whisper model — check env, then common paths */
function discoverLocalModel(): string | null {
	if (process.env.WHISPER_MODEL_PATH) return process.env.WHISPER_MODEL_PATH;

	// Check extension directory relative to known Pi path or home
	const home = process.env.HOME || "";
	const candidates = [
		join(home, ".pi", "agent", "extensions", "voice-input", "models"),
	];

	for (const dir of candidates) {
		if (!existsSync(dir)) continue;
		try {
			const entries = require("node:fs").readdirSync(dir);
			for (const entry of entries) {
				if (entry.endsWith(".bin")) return join(dir, entry);
			}
		} catch {/* ignore */ }
	}

	return null;
}

/** Discover whisper-cli binary */
function discoverWhisperBinary(): string | null {
	try {
		const result = execSync("which whisper-cli", { encoding: "utf8", timeout: 5000 }).trim();
		return result || null;
	} catch {
		return null;
	}
}

/** Determine available STT backend(s) */
interface BackendInfo { cloud: boolean; local: boolean; label: string; }
function getBackendInfo():  BackendInfo {
	const hasCloud = !!process.env.OPENAI_API_KEY;
	const hasLocal = !!(discoverWhisperBinary() && discoverLocalModel());

	return {
	cloud: hasCloud,
	local: hasLocal,
	label: hasLocal ? (hasCloud ? "local+cloud" : "local") : "cloud",
	};
}

// ── State ────────────────────────────────────────────────────────
interface RecordingState {
	recording: boolean;
	process: ChildProcess | null;
	tempFile: string | null;
	startTime: number | null;
	timerId: ReturnType<typeof setInterval> | null;
	processing: boolean;
}

const state: RecordingState = {
	recording: false,
	process: null,
	tempFile: null,
	startTime: null,
	timerId: null,
	processing: false,
};

// ── Helpers ──────────────────────────────────────────────────────

function formatTime(ms: number): string {
	const s = Math.floor(ms / 1000);
	const mins = Math.floor(s / 60);
	const secs = s % 60;
	return mins > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${secs}s`;
}

function createTempFile(): string {
	return join(tmpdir(), `pi-voice-${Date.now()}.wav`);
}

/** Find available audio recorder binary (never throws on missing binaries) */
async function findRecorder(): Promise<"sox" | "ffmpeg" | null> {
	for (const name of ["sox", "ffmpeg"] as const) {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let probe: ChildProcess;
		try {
			probe = spawn(name, ["--help"], { stdio: "pipe" });
		} catch {
			continue; // binary not found
		}
		const code = await new Promise<number | null>((resolve) => {
			let done = false;
			const finish = (c: number | null) => {
				if (done) return;
				done = true;
				if (timer) clearTimeout(timer);
				try { probe.kill(); } catch { /* already gone */ }
				resolve(c);
			};
			// Without this handler, a missing binary emits an uncaught 'error' event
			// (spawn ENOENT) that crashes pi on startup.
			probe.on("error", () => finish(null));
			probe.on("close", (c) => finish(c));
			timer = setTimeout(() => finish(null), 2000);
			// Keep stdout drained so the probe can't block on a full pipe buffer.
			probe.stdout?.resume();
		});
		if (code === 0 || code === 1) return name;
	}
	return null;
}

/** Build recorder command args — platform-aware */
function getRecorderArgs(recorder: "sox" | "ffmpeg", file: string): { cmd: string; args: string[] } {
	if (recorder === "sox") {
		return {
			cmd: "sox",
			args: ["-d", "-r", String(AUDIO_RATE), "-c", String(AUDIO_CHANNELS), file],
		};
	}
	// ffmpeg
	const isMac = platform() === "darwin";
	const baseArgs = ["-y", "-ar", String(AUDIO_RATE), "-ac", String(AUDIO_CHANNELS)];
	if (isMac) {
		return { cmd: "ffmpeg", args: [...baseArgs, "-f", "avfoundation", "-i", ":0", file] };
	}
	return { cmd: "ffmpeg", args: [...baseArgs, "-f", "pulse", "-i", "default", file] };
}

// ── Recording ────────────────────────────────────────────────────

function startRecording(recorder: "sox" | "ffmpeg"): ChildProcess {
	const file = createTempFile();
	state.tempFile = file;
	const { cmd, args } = getRecorderArgs(recorder, file);

	const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
	child.on("error", (err) => {
		console.error(`[voice] Recording failed: ${err.message}`);
		state.process = null;
	});
	return child;
}

async function stopRecording(): Promise<string | null> {
	const child = state.process;
	const file = state.tempFile;
	if (!child || !file) return null;

	child.kill("SIGTERM");
	state.process = null;

	await new Promise((resolve) => setTimeout(resolve, 300));
	return existsSync(file) ? file : null;
}

function cleanupTemp(): void {
	try {
		if (state.tempFile && existsSync(state.tempFile)) unlinkSync(state.tempFile);
	} catch {/* ignore */ }
	finally { state.tempFile = null; }
}

// ── Cloud Transcription (OpenAI API) ────────────────────────────

async function transcribeCloud(file: string): Promise<string | null> {
	if (!process.env.OPENAI_API_KEY) return null;

	const openai = new OpenAI(); // reads OPENAI_API_KEY automatically

	const transcription = await openai.audio.transcriptions.create({
		file: { path: file },
		model: "whisper-1",
		language: process.env.WHISPER_LANGUAGE ?? undefined,
	});

	return transcription.text?.trim() ?? null;
}

// ── Local Transcription (whisper.cpp) ───────────────────────────

async function transcribeLocal(file: string): Promise<string | null> {
	const binary = discoverWhisperBinary();
	const modelPath = discoverLocalModel();

	if (!binary || !modelPath) return null;
	if (!existsSync(modelPath)) 
		 throw new Error(`Local model not found at: ${modelPath}`);

	const language = process.env.WHISPER_LANGUAGE ?? "auto";

	// Build args - get plain text output, no timestamps, suppress all non-result noise
	const args = [
		"--model", modelPath,
		"--file", file,
		"--no-prints",          // only print results, timing info goes to stderr
		"--no-timestamps",      // strip [00:00:xx -> 00:00:xx] prefixes  
		"--language", language === "auto" ? "en" : language,
	];

	if (language !== "auto") {
		args.push("--no-fallback"); // no temperature fallback when explicit lang chosen
	}

	// Execute whisper-cli and capture stdout
	const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
		(resolve) => {
			const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";

			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});

			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			child.on("close", (code) => resolve({ code, stdout, stderr }));
			child.on("error", () => resolve({ code: null, stdout, stderr }));

			// Timeout safety - whisper should finish within 30s for short clips
			setTimeout(() => {
				child.kill("SIGKILL");
				resolve({ code: -1, stdout, stderr });
			}, 30000);
		}
	);

	if (result.code !== 0) {
		console.error(`[voice] whisper-cli error:\n${result.stderr}`);
		throw new Error(`whisper-cli failed (exit ${result.code})`);
	}

	const text = result.stdout.trim();
	return text || null;
}

// ── Transcription Router ────────────────────────────────────────

async function transcribeAudio(file: string): Promise<string | null> {
	const backendHint = process.env.STT_BACKEND?.toLowerCase();
	let localError: unknown = null;

	// Try local, remembering the failure so we can report it if the
	// cloud fallback also fails — otherwise a broken backend would be
	// silently reported as "No speech detected".
	const tryLocal = async (): Promise<string | null> => {
		try {
			return await transcribeLocal(file);
		} catch (err: any) {
			localError = err;
			console.warn(`[voice] Local STT failed, falling back to cloud: ${err.message}`);
			return null;
		}
	};

	if (backendHint === "local") {
		const text = await tryLocal();
		if (text) return text;
		if (localError) throw localError; // local-only: surface the real failure
		return null; // clean empty result = genuinely no speech
	}

	if (backendHint === "cloud") {
		return transcribeCloud(file);
	}

	// Auto (default): try local first for privacy, fall back to cloud
	const text = await tryLocal();
	if (text) return text;
	const cloud = await transcribeCloud(file);
	if (cloud) return cloud;
	if (localError) throw localError; // both failed: report the true cause
	return null; // both ran fine but heard nothing
}

// ── UI Updates ───────────────────────────────────────────────────

interface UIContext {
	notify: (msg: string, type: "info" | "error" | "warning") => void;
	setWidget: (key: string, lines: string[] | undefined) => void;
	setStatus: (key: string, text: string | undefined) => void;
	theme: { fg: (color: string, text: string) => string };
}

function updateRecordingUI(ctx: UIContext): void {
	if (!state.recording && !state.processing) {
		ctx.setWidget("voice", undefined);
		ctx.setStatus("voice", undefined);
		return;
	}

	if (state.processing) {
		const backendInfo = getBackendInfo();
		const icon = backendInfo.local ? "🏠" : "☁️";
		const hint = backendInfo.local ? " Local Whisper" : " Cloud (Whisper API)";
		ctx.setWidget("voice", [ctx.theme.fg("muted", `${icon} Transcribing...${hint}`)]);
		ctx.setStatus("voice", ctx.theme.fg("accent", ` ${icon} Processing`));
		return;
	}

	if (state.startTime && state.recording) {
		const elapsed = Date.now() - state.startTime;
		// Pulsing animation instead of a filling bar
		const pulseIdx = Math.floor((elapsed / 300) % 4);
		const frames = ["▕", "▐", "▓", "▔"];
		const dot = frames[pulseIdx];
		
		ctx.setWidget("voice", [
			ctx.theme.fg("error", `🔴 ${dot} Recording ${formatTime(elapsed)}`),
			ctx.theme.fg("dim", `   Press ${RECORDING_SHORTCUT} to stop`),
		]);
		ctx.setStatus("voice", ctx.theme.fg("error", ` 🔴 Recording ${formatTime(elapsed)}`));
	}
}

// ── Toggle Handler ───────────────────────────────────────────────

async function toggleRecording(
	recorder: "sox" | "ffmpeg",
	ctx: UIContext,
	pasteFn: (text: string) => void,
	backendInfo: BackendInfo
): Promise<void> {
	if (state.processing) return; // don't interrupt active transcription

	if (state.recording && state.process) {
		// ── Stop & transcribe ──
		state.recording = false;
		state.processing = true;
		if (state.timerId) clearInterval(state.timerId);

		updateRecordingUI(ctx);
		ctx.notify("Recording stopped", "info");

		try {
			const file = await stopRecording();
			if (!file) throw new Error("Audio file missing after recording");

			const text = await transcribeAudio(file);

			if (text) {
				pasteFn(text);
				ctx.notify(`Dictated ${text.length} chars`, "info");
			} else {
				ctx.notify("No speech detected", "warning");
			}
		} catch (err: any) {
			console.error("[voice] Transcription error:", err);
			ctx.notify(`Transcription failed: ${err.message.slice(0, 120)}`, "error");
		} finally {
			cleanupTemp();
			state.processing = false;
			state.startTime = null;
			updateRecordingUI(ctx);
		}
	} else {
		// ── Start recording ──
		try {
			const child = startRecording(recorder);
			state.recording = true;
			state.process = child;
			state.startTime = Date.now();

			ctx.notify("Recording started", "info");
			updateRecordingUI(ctx);

			state.timerId = setInterval(() => {
				if (state.recording) updateRecordingUI(ctx);
			}, 200);
		} catch (err: any) {
			ctx.notify(`Failed to start recording: ${err.message}`, "error");
		}
	}
}

// ── Extension Entry Point ────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const recorder = await findRecorder();
	const backendInfo = getBackendInfo();

	if (!recorder) {
		console.warn(
			"[voice] No audio recorder found. Install one:\n" +
				"  macOS: brew install sox\n" +
				" Linux: apt install sox (or ffmpeg)"
		);
		return;
	}

	const backendLabel = (() => {
		if (backendInfo.local && backendInfo.cloud) return "local+cloud";
		if (backendInfo.local) return "🏠 local STT";
		if (backendInfo.cloud) return "☁️ cloud STT";
		return "⚠️ no STT configured";
	})();

	console.log(`[voice] Voice input extension loaded (${RECORDING_SHORTCUT})`);
	console.log(`[voice]  • Recorder: ${recorder}`);
	console.log(`[voice]  • Backend: ${backendLabel}`);
	if (backendInfo.local) {
		console.log(`[voice]  • Model: ${discoverLocalModel()}`);
	}

	pi.registerShortcut(RECORDING_SHORTCUT, {
		description: "Voice dictation (toggle recording)",
		handler: async (ctx) => {
			if (!state.recording && !state.processing) {
				if (!backendInfo.cloud && !backendInfo.local) {
					ctx.ui.notify(
						"No STT configured.\n" +
						"Cloud: export OPENAI_API_KEY=sk-...\n" +
						"Local: brew install whisper-cpp + download model\n" +
						"  Set WHISPER_MODEL_PATH=/path/to/ggml-base.en.bin",
						"error"
					);
					return;
				}
			}

			const pasteFn = (text: string) => {
				if (ctx.hasUI) ctx.ui.pasteToEditor(text);
			};

			const uiCtx: UIContext = {
				notify: (msg, type) => ctx.ui.notify(msg, type),
				setWidget: (key, lines) => ctx.ui.setWidget(key, lines),
				setStatus: (key, text) => ctx.ui.setStatus(key, text),
				theme: ctx.ui.theme,
			};

			await toggleRecording(recorder, uiCtx, pasteFn, backendInfo);
		},
	});

	// Cleanup on session shutdown
	pi.on("session_shutdown", async () => {
		if (state.timerId) clearInterval(state.timerId);
		if (state.process) state.process.kill("SIGTERM");
		cleanupTemp();
	});
}
