// Measuring the canvas terminal render path (plans/canvas-terminal-opaque-floor).
//
// The opaque floor and the WebGL renderer shipped on the strength of a `sample` profile taken
// BEFORE the change: 30% of the webview main thread in CoreText shaping plus WebCore layout,
// with JavaScript at 4.2%. Nothing has measured what came back. This probe exists so that answer
// is a number instead of a claim.
//
// THE HEADLINE METRIC IS ms PER 1000 CHARACTERS, not total time. A chatty agent would otherwise
// look slower than a quiet one, which says nothing about the renderer. Cost per unit of output
// is what compares across runs.
//
// It is OFF unless switched on. A `performance.now()` pair around every write would be a real
// cost on the exact path being optimised, so normal runs must not pay it.

/** Which renderer painted the write. `unknown` is a bucket, never a guess. */
export type TerminalRendererKind = "webgl" | "dom" | "unknown";

export interface TerminalWriteSample {
  /** Milliseconds spent inside `term.write()`. */
  ms: number;
  /** Characters handed to the renderer (UTF-16 units, i.e. `batch.length`). */
  chars: number;
  renderer: TerminalRendererKind;
}

export interface TerminalPerfSummary {
  writes: number;
  chars: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  /** The stall. A mean hides one 200ms hitch among a hundred cheap writes; this does not. */
  maxMs: number;
  /** Cost per 1000 characters. The number to compare between runs. */
  msPer1kChars: number;
}

export type TerminalPerfReport = Record<TerminalRendererKind | "all", TerminalPerfSummary>;

/**
 * Ring capacity. Agents run for hours, and an unbounded array would quietly become the memory
 * problem this whole effort is trying to measure.
 */
export const MAX_PERF_SAMPLES = 4000;

const STORAGE_KEY = "lotus.terminal.perf";

const EMPTY: TerminalPerfSummary = {
  writes: 0,
  chars: 0,
  totalMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  maxMs: 0,
  msPer1kChars: 0,
};

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summariseTerminalWrites(samples: readonly TerminalWriteSample[]): TerminalPerfSummary {
  if (samples.length === 0) return { ...EMPTY };

  const durations = samples.map((s) => s.ms).sort((a, b) => a - b);
  const totalMs = samples.reduce((sum, s) => sum + s.ms, 0);
  const chars = samples.reduce((sum, s) => sum + s.chars, 0);

  return {
    writes: samples.length,
    chars,
    totalMs,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations[durations.length - 1],
    // Guard the divide: a write can legitimately carry zero characters (a bare control
    // sequence), and a whole run of those must not report Infinity.
    msPer1kChars: chars > 0 ? (totalMs / chars) * 1000 : 0,
  };
}

export interface TerminalPerfProbe {
  record(sample: TerminalWriteSample): void;
  report(): TerminalPerfReport;
  reset(): void;
  size(): number;
}

export function createTerminalPerfProbe(): TerminalPerfProbe {
  let samples: TerminalWriteSample[] = [];

  return {
    record(sample) {
      samples.push(sample);
      // Drop from the front in one slice rather than shift()-per-write: shift() is O(n) and
      // this runs on the path being measured.
      if (samples.length > MAX_PERF_SAMPLES) {
        samples = samples.slice(samples.length - MAX_PERF_SAMPLES);
      }
    },
    report() {
      const by = (kind: TerminalRendererKind) =>
        summariseTerminalWrites(samples.filter((s) => s.renderer === kind));
      return {
        webgl: by("webgl"),
        dom: by("dom"),
        unknown: by("unknown"),
        all: summariseTerminalWrites(samples),
      };
    },
    reset() {
      samples = [];
    },
    size() {
      return samples.length;
    },
  };
}

export interface FrameSamplerOptions {
  probe: TerminalPerfProbe;
  /** Resolved at sample time — a node can lose its GPU context mid-run. */
  renderer: () => TerminalRendererKind;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  /** How long after a write frames still count as "under load". */
  activeWindowMs?: number;
}

export interface FrameSampler {
  start(): void;
  stop(): void;
  /** Called on every write, to mark the canvas as currently under load. */
  noteActivity(): void;
}

/**
 * Frame interval while output is flowing.
 *
 * WHY THIS AND NOT THE WRITE CALL: `term.write()` is asynchronous. It queues the chunk and
 * returns, so timing around the call measures the enqueue and misses the paint entirely — and
 * the paint is exactly what the opaque floor and the WebGL renderer changed. When the renderer
 * gets cheaper, frames get shorter; that is the number worth comparing.
 *
 * Only frames under load are recorded. An idle canvas ticking along at a steady 16ms would
 * otherwise flood the sample and bury the busy frames the measurement is about.
 */
export function createFrameSampler({
  probe,
  renderer,
  now = () => performance.now(),
  requestFrame = (cb) => window.requestAnimationFrame(cb),
  cancelFrame = (handle) => window.cancelAnimationFrame(handle),
  activeWindowMs = 500,
}: FrameSamplerOptions): FrameSampler {
  let handle: number | null = null;
  let lastFrameAt: number | null = null;
  let lastActivityAt = -Infinity;
  let running = false;

  const loop = () => {
    handle = null;
    if (!running) return;

    const at = now();
    const underLoad = at - lastActivityAt <= activeWindowMs;

    if (underLoad && lastFrameAt !== null) {
      probe.record({ ms: at - lastFrameAt, chars: 0, renderer: renderer() });
    }
    // Cleared while idle so the first frame after a quiet stretch does not report the gap
    // itself as a frame cost — that would fabricate a huge stall every time an agent resumes.
    lastFrameAt = underLoad ? at : null;

    handle = requestFrame(loop);
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastFrameAt = null;
      handle = requestFrame(loop);
    },
    stop() {
      running = false;
      if (handle !== null) cancelFrame(handle);
      handle = null;
      lastFrameAt = null;
    },
    noteActivity() {
      lastActivityAt = now();
    },
  };
}

/** One probe for the whole canvas, so a mixed board reports both renderers together. */
export const terminalPerfProbe = createTerminalPerfProbe();

/** Frame costs live in their own probe: their `chars` is always 0, which would otherwise
 *  drag the write probe's ms-per-1k-chars to nonsense. */
export const terminalFramePerfProbe = createTerminalPerfProbe();

/**
 * Same storage convention as the WebGL policy (`lotus.terminal.webgl.policy`): flip it in the
 * console, reload, measure. Access is wrapped because private browsing and some webview
 * configurations make `localStorage` throw rather than return null.
 */
export function isTerminalPerfEnabled(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Read the renderer a node ended up with, from the label `LiveAgentNode` writes onto its host.
 * Unknown is a bucket, never a guess: an unlabelled sample must not be silently counted as
 * whichever renderer happens to be the default.
 */
export function resolveRendererKind(host: HTMLElement | null): TerminalRendererKind {
  const value = host?.dataset.renderer;
  return value === "webgl" || value === "dom" ? value : "unknown";
}

export interface TerminalPerfConsole {
  /** Both probes at once: parse cost per 1k chars, and frame interval under load. */
  report(): { parse: TerminalPerfReport; frames: TerminalPerfReport };
  /** Clear both, so a second run in the same session starts from zero. */
  reset(): void;
}

/**
 * Publish the report where it can actually be read.
 *
 * Every agent node calls this on mount, so it is idempotent: installing per node would leave
 * the last mount's closure winning and make repeated output unreadable. Read it from the
 * webview inspector with `__lotusTerminalPerf.report()`.
 */
export function installTerminalPerfConsole(target: Window & typeof globalThis): TerminalPerfConsole {
  const host = target as unknown as { __lotusTerminalPerf?: TerminalPerfConsole };
  const existing = host.__lotusTerminalPerf;
  if (existing) return existing;

  const api: TerminalPerfConsole = {
    report: () => ({ parse: terminalPerfProbe.report(), frames: terminalFramePerfProbe.report() }),
    reset: () => {
      terminalPerfProbe.reset();
      terminalFramePerfProbe.reset();
    },
  };
  host.__lotusTerminalPerf = api;
  return api;
}
