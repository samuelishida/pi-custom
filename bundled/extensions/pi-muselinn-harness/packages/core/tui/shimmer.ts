// ============================================================
// TUI — Shimmer sweep animation (pure, no pi imports).
//
// Ported from oh-my-pi / OMP `modes/theme/shimmer.ts` (MIT): a wall-clock
// driven light band sweeps across the working message in the editor's top
// border. The band's crest is painted with a high-contrast accent + bold,
// so dim text stays legible exactly where the light passes — no need for
// brighter idle colors.
//
// Why wall-clock: the band position is a function of `Date.now()` only, so
// animation smoothness is decoupled from how often the host re-renders.
// Even when the agent loop stalls a frame, the next paint lands at the
// correct position instead of stepping per-frame.
//
// Two intensity profiles (mirrors OMP):
//   - classic: a cosine bump sweeping left → right across the whole line.
//   - kitt:    a single bright head ping-ponging with a quadratic-decay
//              trail behind it (K.I.T.T. scanner).
//
// ANSI resolution is injected (AnsiResolver) so this module stays
// host-independent; callers wire it to pi's Theme.getFgAnsi.
// ============================================================

export type ShimmerMode = "classic" | "kitt" | "disabled";

export interface ShimmerPalette {
  /** Theme color name for chars outside / at the edge of the band. */
  low: string;
  /** Theme color name for chars approaching the crest. */
  mid: string;
  /** Theme color name at the band's crest. */
  high: string;
  /** Whether to also bold the crest tier. Default false. */
  bold?: boolean;
}

export interface ShimmerSegment {
  text: string;
  palette?: ShimmerPalette;
}

/** Injected ANSI resolver: theme color name → escape sequence. */
export interface AnsiResolver {
  fgAnsi(color: string): string;
}

// ─── Animation velocity ──────────────────────────────────────────────────────
// Band/head travel speed in cells per second. Fixed velocity (instead of a
// fixed sweep duration) keeps per-frame movement ≤1 cell at ≥30fps for any
// string length — smoothness independent of message length.
// Band/head travel speed in cells per second. 20 cells/s keeps per-frame
// movement ≤1 cell at ≥20fps, and ~2 cells/frame at the 10fps keep-alive
// floor — a compromise between sweep smoothness and full-tree render cost
// on large sessions (see keepalive.ts).
const SHIMMER_SPEED_CELLS_PER_S = 20;

// ─── Classic sweep tunables ──────────────────────────────────────────────────
const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

// ─── KITT scanner tunables ───────────────────────────────────────────────────
const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;

// ─── Tier thresholds ─────────────────────────────────────────────────────────
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

// ─── Raw ANSI codes ──────────────────────────────────────────────────────────
const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

export const DEFAULT_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "muted",
  high: "accent",
  bold: true,
};

// ─── Palette compilation cache ───────────────────────────────────────────────
// Resolve ANSI codes once per (resolver, palette) pair into ready-to-concat
// prefix/suffix strings; coalesce same-tier runs so each frame emits a handful
// of escape sequences instead of one per code point.
interface TierSeq {
  open: string;
  close: string;
}
interface CompiledPalette {
  low: TierSeq;
  mid: TierSeq;
  high: TierSeq;
}

const kCompiledFor = Symbol("shimmer.compiledFor");
const kCompiled = Symbol("shimmer.compiled");
interface PaletteCache {
  [kCompiledFor]?: AnsiResolver;
  [kCompiled]?: CompiledPalette;
}

function compile(resolver: AnsiResolver, palette: ShimmerPalette): CompiledPalette {
  const p = palette as ShimmerPalette & PaletteCache;
  const cached = p[kCompiled];
  if (cached && p[kCompiledFor] === resolver) return cached;
  const highColorOpen = resolver.fgAnsi(palette.high);
  const out: CompiledPalette = {
    low: { open: resolver.fgAnsi(palette.low), close: FG_RESET },
    mid: { open: resolver.fgAnsi(palette.mid), close: FG_RESET },
    high: {
      open: palette.bold ? `${BOLD_OPEN}${highColorOpen}` : highColorOpen,
      close: palette.bold ? `${BOLD_CLOSE}${FG_RESET}` : FG_RESET,
    },
  };
  p[kCompiledFor] = resolver;
  p[kCompiled] = out;
  return out;
}

// ─── Intensity profiles ──────────────────────────────────────────────────────
/** Smooth cosine bump sweeping left → right with edge padding. */
function classicIntensity(time: number, index: number, length: number): number {
  const period = length + CLASSIC_PADDING * 2;
  const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
  const dist = Math.abs(index + CLASSIC_PADDING - pos);
  if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider K.I.T.T. scanner: a single bright head ping-pongs across the
 * line with a quadratic-decay trail behind it.
 */
function kittIntensity(time: number, index: number, length: number): number {
  const range = length - 1;
  if (range <= 0) return 1;
  const cycleCells = 2 * range;
  const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
  const goingRight = sweep < range;
  const head = goingRight ? sweep : cycleCells - sweep;
  const delta = index - head;
  const abs = delta < 0 ? -delta : delta;
  if (abs <= KITT_HEAD_HALF) return 1;
  const behind = goingRight ? -delta : delta;
  if (behind <= KITT_HEAD_HALF) return 0;
  const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
  if (t >= 1) return 0;
  const f = 1 - t;
  return f * f;
}

type Tier = "low" | "mid" | "high";

function tierFor(intensity: number): Tier {
  if (intensity >= TIER_HIGH) return "high";
  if (intensity >= TIER_MID) return "mid";
  return "low";
}

/** Sweep window (code-point indices) outside which intensity is guaranteed zero. */
function activeBand(mode: "classic" | "kitt", time: number, total: number): { lo: number; hi: number } {
  if (mode === "classic") {
    const period = total + CLASSIC_PADDING * 2;
    const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
    return {
      lo: pos - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH,
      hi: pos - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH,
    };
  }
  const range = total - 1;
  if (range <= 0) return { lo: 0, hi: total };
  const cycleCells = 2 * range;
  const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
  const goingRight = sweep < range;
  const head = goingRight ? sweep : cycleCells - sweep;
  return goingRight
    ? { lo: head - KITT_HEAD_HALF - KITT_TRAIL_LEN, hi: head + KITT_HEAD_HALF }
    : { lo: head - KITT_HEAD_HALF, hi: head + KITT_HEAD_HALF + KITT_TRAIL_LEN };
}

function countCodePoints(text: string): number {
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const c2 = text.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i += 2;
        n++;
        continue;
      }
    }
    i++;
    n++;
  }
  return n;
}

/**
 * Apply a shimmer sweep across one or more segments, treating them as a
 * single continuous string for band positioning. Each segment can supply
 * its own palette so the gradient stays in lockstep while colors differ.
 *
 * `time` is wall-clock ms (caller passes Date.now()).
 */
export function shimmerSegments(
  segments: readonly ShimmerSegment[],
  resolver: AnsiResolver,
  mode: ShimmerMode,
  time: number,
): string {
  let total = 0;
  const perSeg: { text: string; palette: ShimmerPalette }[] = [];
  for (const seg of segments) {
    total += countCodePoints(seg.text);
    perSeg.push({ text: seg.text, palette: seg.palette ?? DEFAULT_SHIMMER_PALETTE });
  }
  if (total === 0) return "";

  // Disabled: no animation — paint every segment in its mid tier so the
  // working line stays legible without movement.
  if (mode === "disabled") {
    let out = "";
    for (const { text, palette } of perSeg) {
      const seq = compile(resolver, palette).mid;
      out += `${seq.open}${text}${seq.close}`;
    }
    return out;
  }

  const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;
  const { lo: bandLo, hi: bandHi } = activeBand(mode, time, total);

  let out = "";
  let index = 0;
  for (const { text, palette } of perSeg) {
    const compiled = compile(resolver, palette);
    let runTier: Tier | null = null;
    let runStart = 0;
    let runEnd = 0;
    let i = 0;
    while (i < text.length) {
      // Surrogate-pair guard: a single code point (emoji) stays atomic.
      const c = text.charCodeAt(i);
      let step = 1;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        const c2 = text.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) step = 2;
      }
      const tier: Tier = index < bandLo || index > bandHi ? "low" : tierFor(intensityFn(time, index, total));
      if (tier !== runTier) {
        if (runTier !== null && runEnd > runStart) {
          const seq = compiled[runTier];
          out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
        }
        runTier = tier;
        runStart = i;
      }
      runEnd = i + step;
      index++;
      i += step;
    }
    if (runTier !== null && runEnd > runStart) {
      const seq = compiled[runTier];
      out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
    }
  }
  return out;
}

/** Convenience: shimmer a single text run. */
export function shimmerText(
  text: string,
  resolver: AnsiResolver,
  mode: ShimmerMode,
  time: number,
  palette?: ShimmerPalette,
): string {
  return shimmerSegments([{ text, palette }], resolver, mode, time);
}
