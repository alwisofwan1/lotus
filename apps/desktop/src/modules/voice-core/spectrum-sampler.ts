/**
 * Audio glue for the spectrum-reactive listening border. Owns the {@link AnalyserNode} lifecycle and a
 * per-frame sampling loop: read the FFT, fold it into bands ({@link aggregateBands}), hand them to a
 * callback. The visual math is separate ({@link ./spectrum-visual}); this file is the only place that
 * touches Web Audio + `requestAnimationFrame`, and it's fully injectable so it can be tested headless.
 *
 * Best-effort by contract: the caller (streaming STT provider) wraps construction/start in try/catch —
 * a webview that can't build an analyser must degrade to the time-based CSS drift, never break capture.
 */
import {
  aggregateBands,
  applyNoiseGate,
  smoothBands,
  hzToBinIndex,
  SPECTRUM_BAND_COUNT,
  SPECTRUM_VOCAL_MAX_HZ,
} from "./spectrum-visual";

/** The slice of the Web Audio graph this sampler needs. Structural Pick of the real DOM types so the
 *  streaming provider can pass its live AudioContext + source; tests inject fakes via `as never`. */
export interface SpectrumAudioGraph {
  context: Pick<BaseAudioContext, "createAnalyser" | "sampleRate">;
  source: Pick<AudioNode, "connect">;
}

/** Frame scheduler — defaults to requestAnimationFrame; injectable for deterministic tests. */
export interface FrameScheduler {
  request(cb: FrameRequestCallback): number;
  cancel(id: number): void;
}

export interface SpectrumSamplerOptions extends SpectrumAudioGraph {
  bandCount: number;
  onSpectrum: (bands: number[]) => void;
  scheduler?: FrameScheduler;
  /** Analyser FFT window. 256 → 128 bins; small keeps the read cheap and the visual snappy. */
  fftSize?: number;
  /** Analyser's own temporal smoothing (0–1). Kept low — the sampler now owns the perceptual
   *  attack/release envelope itself (below), so the analyser should hand over near-raw frames rather
   *  than pre-smoothing them with its own symmetric time constant, which would just add lag on top. */
  smoothing?: number;
  /** Upper bound (Hz) of the frequency range aggregated into bands (A) — see {@link SPECTRUM_VOCAL_MAX_HZ}.
   *  Pass `Infinity` to analyze the full spectrum (pre-existing behavior). */
  maxHz?: number;
  /** Noise-gate floor (0–1, see {@link applyNoiseGate}) — ambient room noise below this never lights
   *  the border. */
  noiseFloor?: number;
  /** Attack/release envelope timing (ms, see {@link smoothBands}) — how fast the border catches up to a
   *  louder signal vs. how slowly it fades back down. */
  attackMs?: number;
  releaseMs?: number;
}

export interface SpectrumSampler {
  /** Build + connect the analyser and begin sampling. Idempotent while running. */
  start(): void;
  /** Stop sampling and disconnect the analyser. Safe to call when already stopped. */
  stop(): void;
}

function defaultScheduler(): FrameScheduler | null {
  if (typeof requestAnimationFrame === "undefined") return null;
  return { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) };
}

export function createSpectrumSampler(opts: SpectrumSamplerOptions): SpectrumSampler {
  const scheduler = opts.scheduler ?? defaultScheduler();
  const noiseFloor = opts.noiseFloor ?? 0.06;
  const envelopeOpts = { attackMs: opts.attackMs ?? 35, releaseMs: opts.releaseMs ?? 260 };
  let analyser: AnalyserNode | null = null;
  // Backed by a concrete ArrayBuffer — getByteFrequencyData's signature requires it (not ArrayBufferLike).
  let buffer: Uint8Array<ArrayBuffer> | null = null;
  let rafId: number | null = null;
  let running = false;
  let maxBinIndex = Infinity;
  // Per-band envelope state, reset on every start() so a fresh capture never inherits a stale release
  // tail from a previous session.
  let prevBands: number[] | null = null;
  let lastFrameTime: number | null = null;

  return {
    start() {
      if (running || !scheduler) return; // no rAF (SSR/headless) → stay dark, never throw
      analyser = opts.context.createAnalyser();
      analyser.fftSize = opts.fftSize ?? 256;
      analyser.smoothingTimeConstant = opts.smoothing ?? 0.15;
      opts.source.connect(analyser);
      buffer = new Uint8Array(analyser.frequencyBinCount);
      maxBinIndex = hzToBinIndex(opts.maxHz ?? SPECTRUM_VOCAL_MAX_HZ, opts.context.sampleRate, analyser.fftSize);
      prevBands = null;
      lastFrameTime = null;
      running = true;

      const loop = (now: number) => {
        if (!running || !analyser || !buffer) return;
        analyser.getByteFrequencyData(buffer);
        const raw = aggregateBands(buffer, opts.bandCount, { maxBinIndex });
        const gated = applyNoiseGate(raw, noiseFloor);
        const dt = lastFrameTime === null ? 0 : now - lastFrameTime;
        const smoothed = smoothBands(prevBands, gated, dt, envelopeOpts);
        prevBands = smoothed;
        lastFrameTime = now;
        opts.onSpectrum(smoothed);
        rafId = scheduler.request(loop);
      };
      rafId = scheduler.request(loop);
    },
    stop() {
      running = false;
      if (rafId != null) scheduler?.cancel(rafId);
      rafId = null;
      try {
        analyser?.disconnect();
      } catch {
        /* analyser may already be gone with its context — ignore */
      }
      analyser = null;
      buffer = null;
    },
  };
}

/** Handle for a self-contained spectrum tap on a MediaStream. */
export interface StreamSpectrumTap {
  /** Stop sampling and release the tap's own AudioContext. Safe to call repeatedly. */
  stop(): void;
}

/**
 * Tap an existing microphone MediaStream for the listening-border spectrum, owning the entire audio
 * graph (its own AudioContext + source + sampler). This is the one-call seam for providers that capture
 * WITHOUT Web Audio (the MediaRecorder batch path) — the streaming provider reuses its existing context
 * instead. Purely best-effort: returns null (with a console breadcrumb) when Web Audio is unavailable or
 * construction fails, so a visualizer problem can never break voice capture.
 */
export function createStreamSpectrumTap(
  stream: MediaStream,
  onSpectrum: (bands: number[]) => void,
  bandCount: number = SPECTRUM_BAND_COUNT,
): StreamSpectrumTap | null {
  try {
    const Ctor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const context = new Ctor();
    // Built after `await getUserMedia`, so the click's user activation may already be spent and the
    // context can start "suspended". A suspended context never runs the analyser: every frame reads
    // zeros and the level meter sits flat while the mic is actually hearing. `createPcmCapture` resumes
    // its own context for the same reason.
    if (context.state === "suspended") void context.resume().catch(() => {});
    const sampler = createSpectrumSampler({
      context,
      source: context.createMediaStreamSource(stream),
      bandCount,
      onSpectrum,
    });
    sampler.start();
    return {
      stop() {
        sampler.stop();
        if (context.state !== "closed") void context.close().catch(() => {});
      },
    };
  } catch (err) {
    console.warn("[voice] spectrum tap unavailable:", err);
    return null;
  }
}
