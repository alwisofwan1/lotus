import { describe, it, expect, vi, afterEach } from "vitest";
import { createSpectrumSampler, createStreamSpectrumTap } from "../spectrum-sampler";

/** A manual frame scheduler: frames only advance when the test calls tick(). Passes a real, monotonically
 *  increasing timestamp to each callback (like real rAF) so dt-dependent logic (attack/release smoothing)
 *  is exercised faithfully — tests can override the step size per call for precise timing control. */
function manualScheduler(startTime = 0) {
  const queue: FrameRequestCallback[] = [];
  let now = startTime;
  return {
    scheduler: {
      request: (cb: FrameRequestCallback) => queue.push(cb),
      cancel: vi.fn(),
    },
    tick: (dtMs = 16) => {
      now += dtMs;
      const cb = queue.shift();
      if (cb) cb(now);
    },
    pending: () => queue.length,
  };
}

/** Fake AnalyserNode whose FFT read fills a caller-supplied constant (or a custom fill function). */
function fakeAnalyser(fill: number | ((buf: Uint8Array) => void), frequencyBinCount = 64) {
  return {
    fftSize: 2048,
    smoothingTimeConstant: 0,
    frequencyBinCount,
    getByteFrequencyData: vi.fn((buf: Uint8Array) => (typeof fill === "function" ? fill(buf) : buf.fill(fill))),
    disconnect: vi.fn(),
  };
}

function fakeContext(analyser: ReturnType<typeof fakeAnalyser>, sampleRate = 48000) {
  return { createAnalyser: vi.fn(() => analyser), sampleRate };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSpectrumSampler", () => {
  it("connects the source into a configured analyser on start", () => {
    const analyser = fakeAnalyser(255);
    const context = fakeContext(analyser);
    const source = { connect: vi.fn() };
    const { scheduler } = manualScheduler();

    const sampler = createSpectrumSampler({
      context: context as never,
      source: source as never,
      bandCount: 8,
      onSpectrum: vi.fn(),
      scheduler,
      fftSize: 256,
      smoothing: 0.75,
    });
    sampler.start();

    expect(context.createAnalyser).toHaveBeenCalledOnce();
    expect(analyser.fftSize).toBe(256);
    expect(analyser.smoothingTimeConstant).toBe(0.75);
    expect(source.connect).toHaveBeenCalledWith(analyser);
  });

  it("emits aggregated bands on each frame while running", () => {
    const analyser = fakeAnalyser(255); // full-scale spectrum → all bands ≈ 1
    const source = { connect: vi.fn() };
    const { scheduler, tick } = manualScheduler();
    const onSpectrum = vi.fn();

    const sampler = createSpectrumSampler({
      context: fakeContext(analyser) as never,
      source: source as never,
      bandCount: 8,
      onSpectrum,
      scheduler,
    });
    sampler.start();

    tick();
    expect(onSpectrum).toHaveBeenCalledTimes(1);
    expect(onSpectrum.mock.calls[0][0]).toHaveLength(8);
    expect(onSpectrum.mock.calls[0][0].every((b: number) => Math.abs(b - 1) < 1e-6)).toBe(true);

    tick();
    expect(onSpectrum).toHaveBeenCalledTimes(2);
  });

  it("stops emitting and disconnects the analyser after stop()", () => {
    const analyser = fakeAnalyser(128);
    const source = { connect: vi.fn() };
    const { scheduler, tick } = manualScheduler();
    const onSpectrum = vi.fn();

    const sampler = createSpectrumSampler({
      context: fakeContext(analyser) as never,
      source: source as never,
      bandCount: 4,
      onSpectrum,
      scheduler,
    });
    sampler.start();
    tick();
    expect(onSpectrum).toHaveBeenCalledTimes(1);

    sampler.stop();
    tick(); // any already-queued frame must be a no-op
    expect(onSpectrum).toHaveBeenCalledTimes(1);
    expect(analyser.disconnect).toHaveBeenCalledOnce();
    expect(scheduler.cancel).toHaveBeenCalled();
  });

  it("restricts sampling to the vocal range by default (A) — energy above ~6kHz never reaches a band", () => {
    // sampleRate=48000, fftSize=256 (default) → 128 bins spanning 0–24kHz. hzToBinIndex(6000,48000,256)=32,
    // so bins 32..127 sit above the vocal cutoff. Put energy ONLY there and expect near-silent output.
    const analyser = fakeAnalyser((buf) => buf.fill(255, 32, 128), 128);
    const source = { connect: vi.fn() };
    const { scheduler, tick } = manualScheduler();
    const onSpectrum = vi.fn();

    const sampler = createSpectrumSampler({
      context: fakeContext(analyser, 48000) as never,
      source: source as never,
      bandCount: 8,
      onSpectrum,
      scheduler,
    });
    sampler.start();
    tick();

    expect(onSpectrum.mock.calls[0][0].every((b: number) => b < 0.05)).toBe(true);
  });

  it("applies a noise gate by default (B) — a low constant ambient level reads as silence", () => {
    const analyser = fakeAnalyser(6, 32); // 6/255 ≈ 0.024 — well under a sane noise floor
    const source = { connect: vi.fn() };
    const { scheduler, tick } = manualScheduler();
    const onSpectrum = vi.fn();

    const sampler = createSpectrumSampler({
      context: fakeContext(analyser) as never,
      source: source as never,
      bandCount: 4,
      onSpectrum,
      scheduler,
    });
    sampler.start();
    tick();

    expect(onSpectrum.mock.calls[0][0]).toEqual([0, 0, 0, 0]);
  });

  it("releases slowly by default (B) — a sudden silence doesn't zero the border in a single frame", () => {
    let fillValue = 255;
    const analyser = fakeAnalyser((buf) => buf.fill(fillValue), 32);
    const source = { connect: vi.fn() };
    const { scheduler, tick } = manualScheduler();
    const onSpectrum = vi.fn();

    const sampler = createSpectrumSampler({
      context: fakeContext(analyser) as never,
      source: source as never,
      bandCount: 4,
      onSpectrum,
      scheduler,
    });
    sampler.start();
    tick(); // first frame: raw passthrough, bands ≈ 1
    expect(onSpectrum.mock.calls[0][0][0]).toBeCloseTo(1, 2);

    fillValue = 0; // voice stops abruptly
    tick(16); // one ~60fps frame later
    const afterOneFrame = onSpectrum.mock.calls[1][0][0];
    expect(afterOneFrame).toBeGreaterThan(0.5); // still mostly lit — release hasn't caught up yet
    expect(afterOneFrame).toBeLessThan(1); // but it HAS started falling
  });

  it("createStreamSpectrumTap builds its own graph from a MediaStream and emits bands until stopped", async () => {
    const analyser = fakeAnalyser(255);
    const source = { connect: vi.fn() };
    const ctx = {
      createAnalyser: vi.fn(() => analyser),
      createMediaStreamSource: vi.fn(() => source),
      sampleRate: 48000,
      state: "running",
      close: vi.fn(async () => {}),
    };
    vi.stubGlobal("AudioContext", function FakeAudioContext() { return ctx; });
    const onSpectrum = vi.fn();

    const tap = createStreamSpectrumTap({} as MediaStream, onSpectrum);
    expect(tap).not.toBeNull();
    expect(ctx.createMediaStreamSource).toHaveBeenCalled();
    expect(source.connect).toHaveBeenCalledWith(analyser);

    await new Promise((r) => requestAnimationFrame(() => r(null))); // let one sampling frame run
    expect(onSpectrum).toHaveBeenCalled();

    tap!.stop();
    expect(ctx.close).toHaveBeenCalled(); // the tap owns its context and must release it
    const calls = onSpectrum.mock.calls.length;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(onSpectrum.mock.calls.length).toBe(calls); // no frames after stop
  });

  it("createStreamSpectrumTap resumes a context that starts suspended, so the meter does not sit flat", () => {
    const ctx = {
      createAnalyser: vi.fn(() => fakeAnalyser(0)),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
      sampleRate: 48000,
      state: "suspended",
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    vi.stubGlobal("AudioContext", function FakeAudioContext() { return ctx; });

    const tap = createStreamSpectrumTap({} as MediaStream, vi.fn());
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    tap!.stop();
  });

  it("createStreamSpectrumTap returns null (no throw) when Web Audio is unavailable", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(createStreamSpectrumTap({} as MediaStream, vi.fn())).toBeNull();
  });

  it("does nothing (no throw) when no frame scheduler is available (SSR/headless)", () => {
    vi.stubGlobal("requestAnimationFrame", undefined); // no rAF → defaultScheduler() returns null
    try {
      const analyser = fakeAnalyser(200);
      const source = { connect: vi.fn() };
      const onSpectrum = vi.fn();

      const sampler = createSpectrumSampler({
        context: fakeContext(analyser) as never,
        source: source as never,
        bandCount: 4,
        onSpectrum,
        // no scheduler passed — falls back to the (now unavailable) rAF
      });
      expect(() => sampler.start()).not.toThrow();
      expect(source.connect).not.toHaveBeenCalled();
      expect(onSpectrum).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
