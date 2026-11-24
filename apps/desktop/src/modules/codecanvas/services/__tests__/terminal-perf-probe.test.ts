import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PERF_SAMPLES,
  createFrameSampler,
  createTerminalPerfProbe,
  installTerminalPerfConsole,
  isTerminalPerfEnabled,
  summariseTerminalWrites,
  terminalFramePerfProbe,
  terminalPerfProbe,
  type TerminalWriteSample,
} from "../terminal-perf-probe";

/**
 * Measuring the canvas terminal render path (plans/canvas-terminal-opaque-floor).
 *
 * The opaque floor and the WebGL renderer shipped on the strength of a `sample` profile taken
 * BEFORE the change: 30% of the webview main thread in CoreText shaping plus WebCore layout,
 * with JavaScript at 4.2%. Nothing has measured what came back. This probe exists so the answer
 * is a number rather than a claim.
 *
 * The headline metric is ms per 1k characters written, not total time: an agent that produces
 * more output would otherwise look slower than one that produces less, which says nothing about
 * the renderer. Cost per unit of output is comparable across runs.
 */

const sample = (ms: number, chars = 1024, renderer: TerminalWriteSample["renderer"] = "webgl"): TerminalWriteSample => ({
  ms,
  chars,
  renderer,
});

describe("summariseTerminalWrites", () => {
  it("returns zeros for an empty run instead of NaN", () => {
    // A node that never received output must not poison the aggregate with NaN.
    const s = summariseTerminalWrites([]);
    expect(s).toEqual({ writes: 0, chars: 0, totalMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, msPer1kChars: 0 });
  });

  it("counts writes and characters", () => {
    const s = summariseTerminalWrites([sample(1, 100), sample(2, 200)]);
    expect(s.writes).toBe(2);
    expect(s.chars).toBe(300);
    expect(s.totalMs).toBeCloseTo(3);
  });

  it("reports the cost per 1k characters, which is what compares across runs", () => {
    // 4ms spread over 2000 chars = 2ms per 1k.
    const s = summariseTerminalWrites([sample(3, 1500), sample(1, 500)]);
    expect(s.msPer1kChars).toBeCloseTo(2);
  });

  it("never divides by zero when writes carried no characters", () => {
    const s = summariseTerminalWrites([sample(5, 0)]);
    expect(s.msPer1kChars).toBe(0);
    expect(Number.isFinite(s.msPer1kChars)).toBe(true);
  });

  it("takes percentiles by nearest rank on the sorted samples", () => {
    const samples = [4, 1, 3, 2].map((ms) => sample(ms));
    const s = summariseTerminalWrites(samples);
    expect(s.p50Ms).toBe(2);
    expect(s.maxMs).toBe(4);
  });

  it("puts p95 near the tail, where a stall actually shows up", () => {
    // 99 cheap writes and one 200ms stall: the mean hides it, p95 and max do not.
    const samples = [...Array.from({ length: 99 }, () => sample(1)), sample(200)];
    const s = summariseTerminalWrites(samples);
    expect(s.p50Ms).toBe(1);
    expect(s.maxMs).toBe(200);
    expect(s.p95Ms).toBe(1);
  });

  it("is order-independent", () => {
    const a = summariseTerminalWrites([sample(1), sample(9), sample(5)]);
    const b = summariseTerminalWrites([sample(9), sample(5), sample(1)]);
    expect(a).toEqual(b);
  });
});

describe("terminal perf probe", () => {
  it("groups by renderer so WebGL and DOM can be compared in one run", () => {
    // The whole point of the A/B: with a mixed board, both renderers report side by side.
    const probe = createTerminalPerfProbe();
    probe.record(sample(4, 1000, "webgl"));
    probe.record(sample(10, 1000, "dom"));

    const report = probe.report();
    expect(report.webgl.writes).toBe(1);
    expect(report.dom.writes).toBe(1);
    expect(report.all.writes).toBe(2);
    expect(report.webgl.msPer1kChars).toBeCloseTo(4);
    expect(report.dom.msPer1kChars).toBeCloseTo(10);
  });

  it("keeps only the most recent samples so a long session cannot leak", () => {
    // Agents run for hours. An unbounded array would quietly become the memory problem this
    // whole effort is trying to measure.
    const probe = createTerminalPerfProbe();
    for (let i = 0; i < MAX_PERF_SAMPLES + 50; i++) probe.record(sample(i));

    expect(probe.size()).toBe(MAX_PERF_SAMPLES);
    // The oldest 50 were dropped, so the smallest surviving duration is 50.
    expect(probe.report().all.maxMs).toBe(MAX_PERF_SAMPLES + 49);
  });

  it("resets cleanly between measurement runs", () => {
    const probe = createTerminalPerfProbe();
    probe.record(sample(5));
    probe.reset();
    expect(probe.size()).toBe(0);
    expect(probe.report().all.writes).toBe(0);
  });

  it("treats an unlabelled node as its own bucket rather than guessing", () => {
    const probe = createTerminalPerfProbe();
    probe.record(sample(3, 1000, "unknown"));
    expect(probe.report().unknown.writes).toBe(1);
    expect(probe.report().webgl.writes).toBe(0);
  });
});

describe("isTerminalPerfEnabled", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("is off unless explicitly switched on", () => {
    // Normal runs must pay nothing: no timing calls, no allocation.
    expect(isTerminalPerfEnabled()).toBe(false);
  });

  it("turns on via the same storage convention as the WebGL policy", () => {
    window.localStorage.setItem("lotus.terminal.perf", "1");
    expect(isTerminalPerfEnabled()).toBe(true);
  });

  it("never throws when storage is unavailable", () => {
    // Private browsing and some webview configurations make localStorage throw on access.
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      expect(isTerminalPerfEnabled()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("frame sampler", () => {
  /**
   * WHY FRAMES AND NOT JUST WRITES: `term.write()` is asynchronous — it queues the chunk and
   * returns, so timing around the call measures the enqueue, not the paint. The opaque floor and
   * the WebGL renderer changed the PAINT. Frame interval while output is flowing is the metric
   * that actually moves when the renderer gets cheaper.
   *
   * Frames are only counted while output is recent: a canvas sitting idle at a steady 60fps
   * would otherwise flood the sample with meaningless 16ms entries and bury the busy ones.
   */
  function harness() {
    let clock = 0;
    const frames: FrameRequestCallback[] = [];
    const probe = createTerminalPerfProbe();
    const sampler = createFrameSampler({
      probe,
      renderer: () => "webgl",
      now: () => clock,
      requestFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: () => {},
      activeWindowMs: 500,
    });
    const tick = (advanceMs: number) => {
      clock += advanceMs;
      const due = frames.splice(0);
      due.forEach((cb) => cb(clock));
    };
    return { sampler, probe, tick, at: (ms: number) => (clock = ms) };
  }

  it("treats the first frame as a baseline, since an interval needs two", () => {
    const { sampler, probe, tick } = harness();
    sampler.start();
    sampler.noteActivity();

    tick(16);

    expect(probe.report().all.writes).toBe(0);
  });

  it("records the interval between frames while output is flowing", () => {
    const { sampler, probe, tick } = harness();
    sampler.start();
    sampler.noteActivity();

    tick(16); // baseline
    tick(16);
    tick(20);

    const all = probe.report().all;
    expect(all.writes).toBe(2);
    expect(all.maxMs).toBe(20);
  });

  it("stops recording once output has been quiet past the window", () => {
    const { sampler, probe, tick } = harness();
    sampler.start();
    sampler.noteActivity();
    tick(16); // baseline
    tick(16); // recorded

    // Nothing written for longer than the activity window: idle frames are not the signal.
    tick(600);
    tick(16);

    expect(probe.report().all.writes).toBe(1);
  });

  it("resumes when output starts again", () => {
    const { sampler, probe, tick } = harness();
    sampler.start();
    sampler.noteActivity();
    tick(16); // baseline
    tick(16); // recorded
    tick(600); // goes idle

    sampler.noteActivity();
    tick(16); // baseline again
    tick(16); // recorded

    expect(probe.report().all.writes).toBe(2);
  });

  it("does not record the first frame after a gap, which would measure the gap itself", () => {
    // The delta across an idle stretch is not a frame cost; counting it would report a
    // fabricated 600ms stall every time an agent resumes.
    const { sampler, probe, tick } = harness();
    sampler.start();
    sampler.noteActivity();
    tick(16);
    tick(16);
    tick(600);
    sampler.noteActivity();
    tick(16);
    tick(16);

    expect(probe.report().all.maxMs).toBe(16);
  });

  it("stops cleanly", () => {
    const { sampler, probe, tick } = harness();
    sampler.start();
    sampler.noteActivity();
    sampler.stop();
    tick(16);
    expect(probe.report().all.writes).toBe(0);
  });
});

describe("installTerminalPerfConsole", () => {
  it("exposes one report function however many nodes install it", () => {
    // Every agent node calls this on mount. Installing per node would leave the last one's
    // closure winning and make repeated console output unreadable.
    const target: Record<string, unknown> = {};
    const install = () => installTerminalPerfConsole(target as never);
    install();
    const first = target.__lotusTerminalPerf;
    install();
    install();
    expect(target.__lotusTerminalPerf).toBe(first);
  });

  it("returns both probes plus the renderer split", () => {
    const target: Record<string, unknown> = {};
    installTerminalPerfConsole(target as never);
    terminalPerfProbe.reset();
    terminalFramePerfProbe.reset();
    terminalPerfProbe.record(sample(4, 1000, "webgl"));
    terminalFramePerfProbe.record({ ms: 33, chars: 0, renderer: "webgl" });

    const api = target.__lotusTerminalPerf as { report(): { parse: unknown; frames: unknown } };
    const report = api.report() as {
      parse: { webgl: { writes: number } };
      frames: { webgl: { p50Ms: number } };
    };
    expect(report.parse.webgl.writes).toBe(1);
    expect(report.frames.webgl.p50Ms).toBe(33);
  });

  it("resets both probes together, so a second measurement run starts clean", () => {
    const target: Record<string, unknown> = {};
    installTerminalPerfConsole(target as never);
    terminalPerfProbe.record(sample(1));
    terminalFramePerfProbe.record({ ms: 16, chars: 0, renderer: "dom" });

    (target.__lotusTerminalPerf as { reset(): void }).reset();

    expect(terminalPerfProbe.size()).toBe(0);
    expect(terminalFramePerfProbe.size()).toBe(0);
  });
});
