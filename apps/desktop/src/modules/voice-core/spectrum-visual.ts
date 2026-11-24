/**
 * Pure visual math for the NL command bar's spectrum-reactive "listening" border (PLAN: E · Hairline).
 *
 * The command bar taps the live mic through an {@link AnalyserNode} and hands the FFT magnitudes here.
 * These helpers turn raw frequency bytes into a small set of perceptual bands, then into a CSS
 * `conic-gradient` painted around the pill's border — so the frame shimmers with the *texture* of speech,
 * not just its volume. No DOM, no Web Audio: everything here is deterministic and unit-testable. The
 * audio glue (AnalyserNode lifecycle + frame loop) lives in {@link ./spectrum-sampler}.
 */

/** How many bands the border is divided into. A design constant shared by the sampler and the CSS. */
export const SPECTRUM_BAND_COUNT = 14;

/** Upper bound of the frequency range the visualizer analyzes. An AnalyserNode running at the hardware
 *  rate (~48 kHz) spends most of its bins above 6 kHz, where ordinary speech has essentially no energy
 *  — those bins are just silence diluting every band's average. Capping here (see {@link hzToBinIndex})
 *  means all {@link SPECTRUM_BAND_COUNT} bands sit inside the range speech actually occupies, so the
 *  per-band coloring the effect exists to show is visible on every band, not just the first couple. */
export const SPECTRUM_VOCAL_MAX_HZ = 6000;

/**
 * Convert a target frequency to the FFT bin index that contains it, given the audio graph's sample rate
 * and the analyser's `fftSize`. Pure arithmetic — no Web Audio APIs — so the Hz-range concern (A) stays
 * unit-testable without mocking `AnalyserNode`. Bin `i` covers frequency `i * sampleRate / fftSize`, so
 * inverting gives `hz * fftSize / sampleRate`. Clamped to 0 for non-positive input.
 */
export function hzToBinIndex(hz: number, sampleRate: number, fftSize: number): number {
  if (hz <= 0) return 0;
  return Math.floor((hz * fftSize) / sampleRate);
}

export interface AggregateBandsOptions {
  /** Only bins below this index are aggregated (see {@link hzToBinIndex}); the rest of `freq` is
   *  ignored. Clamped to `freq.length`. Omit to use the full spectrum. */
  maxBinIndex?: number;
}

/**
 * Fold raw FFT magnitude bytes (0–255, from `AnalyserNode.getByteFrequencyData`) into `bandCount`
 * bands, each normalized to 0–1.
 *
 * Bands are spaced *quadratically*, not linearly, WITHIN the considered range: speech energy is still
 * heavily bass-weighted even inside the vocal band, so linear grouping would waste resolution on the
 * quieter upper end. Squared edges give the low/voice range finer resolution and let the visual actually
 * move. Robust to any input length: never returns NaN, always returns exactly `max(0, bandCount)` values.
 */
export function aggregateBands(freq: Uint8Array, bandCount: number, opts: AggregateBandsOptions = {}): number[] {
  const out = new Array(Math.max(0, bandCount)).fill(0);
  const fullLength = freq.length;
  const n = Math.max(0, Math.min(opts.maxBinIndex ?? fullLength, fullLength));
  if (n === 0 || bandCount <= 0) return out;

  let start = 0;
  for (let b = 0; b < bandCount; b++) {
    // Quadratic spacing biases resolution toward low frequencies; the last band takes the remainder.
    let end = b === bandCount - 1 ? n : Math.floor(n * ((b + 1) / bandCount) ** 2);
    if (end <= start) end = Math.min(n, start + 1); // guarantee ≥1 bin while bins remain
    let sum = 0;
    for (let i = start; i < end; i++) sum += freq[i];
    const width = end - start;
    out[b] = width > 0 ? sum / width / 255 : 0;
    start = end;
  }
  return out;
}

/**
 * Linear noise gate: values at or below `floor` become 0 (ambient room noise never lights the ring),
 * values above it are rescaled back to the full 0–1 range so peaks still reach 1. Pure, per-band.
 */
export function applyNoiseGate(bands: number[], floor: number): number[] {
  if (floor <= 0) return bands.slice();
  const range = 1 - floor;
  return bands.map((v) => (v <= floor ? 0 : range > 0 ? Math.min(1, (v - floor) / range) : 1));
}

export interface SmoothBandsOptions {
  /** Time constant (ms) for rising values — how fast the visual "attacks" a louder signal. Small: the
   *  border should feel like it's reacting the instant you speak, not catching up a beat later. */
  attackMs?: number;
  /** Time constant (ms) for falling values — how slowly the visual "releases" back down. Large relative
   *  to attackMs: a slow fade-out reads as smooth and intentional, an instant drop reads as flicker. */
  releaseMs?: number;
}

/**
 * Move each band from `prev` toward `next` using an exponential attack/release envelope — the asymmetry
 * (fast up, slow down) is what separates a "live VU meter" feel from a laggy or flickery one. Framerate
 * independent: the step size is derived from `dtMs` via `1 - exp(-dt/tau)`, so the same elapsed time
 * produces the same result whether it arrived as one frame or several smaller ones. `prev === null`
 * (the very first frame, nothing to smooth from yet) passes `next` through unsmoothed.
 */
export function smoothBands(prev: number[] | null, next: number[], dtMs: number, opts: SmoothBandsOptions = {}): number[] {
  if (prev === null) return next.slice();
  const attackMs = opts.attackMs ?? 35;
  const releaseMs = opts.releaseMs ?? 260;
  if (dtMs <= 0) return prev.slice();
  return next.map((target, i) => {
    const current = prev[i] ?? 0;
    const tau = target > current ? attackMs : releaseMs;
    const coeff = 1 - Math.exp(-dtMs / tau);
    return current + (target - current) * coeff;
  });
}

/** Average band energy — the single "how loud right now" number the halo's overall glow follows. */
export function computeLevel(bands: number[]): number {
  return bands.length ? bands.reduce((sum, b) => sum + b, 0) / bands.length : 0;
}

export interface OnsetPulseOptions {
  /** A rise in level greater than this (over one frame) counts as a new syllable onset and retriggers
   *  the pulse. Small enough to catch ordinary speech attacks, large enough that ambient jitter and the
   *  envelope's own noise-gate/attack ripple don't false-trigger it. */
  triggerDelta?: number;
  /** Exponential decay time constant (ms) once triggered — how long the "kick" lingers. */
  decayMs?: number;
}

/**
 * A one-shot brightness "kick" the halo rides on top of its steady glow, so the border reads as
 * responding to the *rhythm* of speech (syllable onsets), not just its average loudness. Retriggers to
 * (up to) full strength when `levelDelta` (this frame's level minus last frame's) exceeds
 * `triggerDelta`, otherwise decays exponentially — same `1 - exp(-dt/tau)` shape as {@link smoothBands},
 * so it's framerate-independent and never produces NaN even at `dtMs = 0`.
 */
export function stepOnsetPulse(prevPulse: number, levelDelta: number, dtMs: number, opts: OnsetPulseOptions = {}): number {
  const triggerDelta = opts.triggerDelta ?? 0.15;
  const decayMs = opts.decayMs ?? 180;
  if (levelDelta > triggerDelta) {
    // Overshoot scales the kick a little beyond 1 before clamping, so a sudden loud attack still reads
    // as more forceful than a borderline one — then clamp, since CSS opacity/box-shadow calcs assume ≤1.
    return Math.min(1, Math.max(prevPulse, levelDelta / triggerDelta));
  }
  if (dtMs <= 0) return prevPulse;
  return prevPulse * Math.exp(-dtMs / decayMs);
}

/** Where band 0 (bass) is anchored, in CSS conic-gradient degrees (0 = top, clockwise; 90 = right).
 *  CanvasNlCommandBar's mic button sits on the right side of the pill, so the spectrum visually
 *  originates there: the lowest, usually-loudest band glows right where the sound is being captured,
 *  and higher bands fan out symmetrically in both directions to meet at the opposite (left) side. */
export const NL_FX_ANCHOR_DEG = 90;

export interface ConicGradientOptions {
  /** CSS custom property (name only, no `var()`) supplying the primary accent — anchored at the mic
   *  (see {@link NL_FX_ANCHOR_DEG}). Defaults to the FX accent (`--nl-fx-accent`), which the stylesheet
   *  keys to the theme's vivid wire accent so the border never washes out against the near-white
   *  default text accent. */
  colorVar?: string;
  /** CSS custom property for the alt accent — the far end of the mirrored sweep, opposite the mic. */
  colorVarAlt?: string;
  /** Literal colors used as `var()` fallbacks, so undefined accents never invalidate the gradient. */
  fallbackColor?: string;
  fallbackColorAlt?: string;
  /** color-mix percentage a silent band maps to (keeps the frame faintly visible, never invisible). */
  minPct?: number;
  /** color-mix percentage a full-energy band maps to. */
  maxPct?: number;
  /** Where band 0 anchors, in degrees. Defaults to {@link NL_FX_ANCHOR_DEG}. This is a fixed spatial
   *  reference, not an animated rotation — the border's motion comes entirely from the live band values
   *  changing, so it always reads as "reacting to your voice" rather than spinning on its own. */
  anchorDeg?: number;
}

/** Band energy above this whitens toward a hot filament tip. Low enough that ordinary speech peaks
 *  ignite it — the hot-core-on-thin-line look is what sells the holographic (Jarvis) read. */
const HOT_THRESHOLD = 0.75;
/** Max white share a peaking band mixes in — hot enough to read as a filament, low enough that the
 *  arc keeps its hue (full white would erase the spectrum coloring the effect exists to show). */
const HOT_MAX_WHITE = 45;

/**
 * Build a CSS `conic-gradient` where each band's arc reflects its energy, so painted around the pill's
 * border the frame lights up unevenly with the voice's spectrum. Four layers of expression:
 *   • anchor     — band 0 (bass) is placed at the mic ({@link NL_FX_ANCHOR_DEG}); higher bands mirror
 *                  outward in BOTH directions, meeting at the point directly opposite the mic. The light
 *                  visually originates where the sound is being captured (C).
 *   • brightness — band energy maps to the accent's alpha (minPct → maxPct),
 *   • hue        — drifts from the primary accent (bass, at the mic) to the alt accent (treble, opposite),
 *   • filament   — near-peak bands whiten, reading as a hot core at the loudest arcs.
 * The string is assigned to `--nl-spectrum` and painted directly as the masked ring's background (see
 * the WKWebView notes in canvas-nl-listening-fx.css). Returns `"none"` for an empty spectrum so the CSS
 * `var(--nl-spectrum, <drift>)` fallback takes over.
 */
export function spectrumToConicGradient(bands: number[], opts: ConicGradientOptions = {}): string {
  const n = bands.length;
  if (n === 0) return "none";
  const a = `var(${opts.colorVar ?? "--nl-fx-accent"}, ${opts.fallbackColor ?? "#22d3ee"})`;
  const b = `var(${opts.colorVarAlt ?? "--nl-fx-accent-alt"}, ${opts.fallbackColorAlt ?? "#a78bfa"})`;
  // Wide dynamic range: quiet arcs sink close to the glass, peaks hit full — the contrast is what
  // makes the coloring READ as a spectrum on a thin line instead of a uniformly lit ring.
  const minPct = opts.minPct ?? 12;
  const maxPct = opts.maxPct ?? 100;

  const stopAt = (value: number, index: number, deg: number): string => {
    const v = value < 0 ? 0 : value > 1 ? 1 : value;
    // Hue position follows the band's place in the spectrum (bass → primary, treble → alt) — independent
    // of WHERE it's painted, so the mirrored placement below doesn't need to touch this at all.
    const t = n === 1 ? 0 : Math.round((index / (n - 1)) * 100);
    let hue = t === 0 ? a : t === 100 ? b : `color-mix(in oklab, ${a} ${100 - t}%, ${b})`;
    // Filament: peaks whiten. Quiet bands stay pure accent — white would grey them out.
    if (v > HOT_THRESHOLD) {
      const white = Math.round(((v - HOT_THRESHOLD) / (1 - HOT_THRESHOLD)) * HOT_MAX_WHITE);
      if (white > 0) hue = `color-mix(in oklab, ${hue} ${100 - white}%, white)`;
    }
    const pct = Math.round(minPct + (maxPct - minPct) * v);
    return `color-mix(in oklab, ${hue} ${pct}%, transparent) ${deg}deg`;
  };

  // Fold the spectrum around the anchor: relative angle r=180 is the mic (band 0); r=0 and r=360 are the
  // same physical point directly opposite it, both carrying band (n-1) so the sweep wraps seamlessly.
  // Walking r from 0 → 360 therefore visits band indices n-1 → 0 → n-1, i.e. two mirrored arms.
  const half = n - 1;
  const stops: string[] =
    half === 0
      ? [stopAt(bands[0], 0, 0), stopAt(bands[0], 0, 360)]
      : [
          ...Array.from({ length: half + 1 }, (_, k) => {
            const i = half - k; // k=0 → i=half (r=0); k=half → i=0 (r=180)
            return stopAt(bands[i], i, Number(((180 * (half - i)) / half).toFixed(2)));
          }),
          ...Array.from({ length: half }, (_, k) => {
            const i = k + 1; // i=1 → r just past 180; i=half → r=360
            return stopAt(bands[i], i, Number((180 + (180 * i) / half).toFixed(2)));
          }),
        ];

  const from = Number(((opts.anchorDeg ?? NL_FX_ANCHOR_DEG) - 180).toFixed(1));
  return `conic-gradient(from ${from}deg, ${stops.join(", ")})`;
}
