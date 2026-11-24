import { describe, it, expect } from "vitest";
import {
  aggregateBands,
  spectrumToConicGradient,
  hzToBinIndex,
  applyNoiseGate,
  smoothBands,
  computeLevel,
  stepOnsetPulse,
} from "../spectrum-visual";

describe("hzToBinIndex", () => {
  it("maps a target frequency to the FFT bin index that contains it", () => {
    // bin width = sampleRate / fftSize = 48000 / 2048 ≈ 23.4 Hz/bin. 6000 Hz → bin ≈ 256.
    expect(hzToBinIndex(6000, 48000, 2048)).toBe(Math.floor((6000 * 2048) / 48000));
  });

  it("clamps to 0 for a frequency below the lowest bin", () => {
    expect(hzToBinIndex(0, 48000, 2048)).toBe(0);
    expect(hzToBinIndex(-100, 48000, 2048)).toBe(0);
  });

  it("scales with sample rate — a lower rate packs Hz into narrower bins, needing more of them", () => {
    const at48k = hzToBinIndex(6000, 48000, 2048);
    const at16k = hzToBinIndex(6000, 16000, 2048);
    expect(at16k).toBeGreaterThan(at48k);
  });
});

describe("aggregateBands", () => {
  it("normalizes a full-scale uniform spectrum to all-1 bands", () => {
    const freq = new Uint8Array(128).fill(255);
    const bands = aggregateBands(freq, 14);
    expect(bands).toHaveLength(14);
    for (const b of bands) expect(b).toBeCloseTo(1, 5);
  });

  it("maps a mid magnitude to ~0.5 (255 → 1 scale)", () => {
    const bands = aggregateBands(new Uint8Array(64).fill(128), 8);
    for (const b of bands) expect(b).toBeCloseTo(128 / 255, 5);
  });

  it("concentrates low-frequency energy in the low bands (quadratic spacing)", () => {
    const freq = new Uint8Array(64);
    freq.fill(255, 0, 2); // energy only in the two lowest bins
    const bands = aggregateBands(freq, 8);
    expect(bands[0]).toBeGreaterThan(0.5); // lowest band is hot
    expect(bands[bands.length - 1]).toBe(0); // highest band is silent
  });

  it("returns bandCount zeros for an empty spectrum (no NaN)", () => {
    const bands = aggregateBands(new Uint8Array(0), 14);
    expect(bands).toHaveLength(14);
    expect(bands.every((b) => b === 0)).toBe(true);
  });

  it("never yields NaN when there are fewer bins than bands", () => {
    const bands = aggregateBands(new Uint8Array([255, 255, 255]), 14);
    expect(bands).toHaveLength(14);
    expect(bands.every((b) => Number.isFinite(b))).toBe(true);
  });

  it("returns an empty array when bandCount is zero or negative", () => {
    expect(aggregateBands(new Uint8Array(32).fill(255), 0)).toEqual([]);
    expect(aggregateBands(new Uint8Array(32).fill(255), -3)).toEqual([]);
  });

  it("ignores bins beyond maxBinIndex (vocal-range focus — speech energy lives well under the Nyquist ceiling)", () => {
    const freq = new Uint8Array(128).fill(255); // full-scale everywhere, including the ignored tail
    const bands = aggregateBands(freq, 8, { maxBinIndex: 16 });
    // Every band's window now falls inside the restricted [0, 16) slice, so it should still read hot —
    // the point is that bins 16..127 (pure silence in real audio) never get to dilute the average.
    for (const b of bands) expect(b).toBeCloseTo(1, 5);
  });

  it("keeps quiet high bins from being counted once restricted (the actual payoff of A)", () => {
    const freq = new Uint8Array(128).fill(0);
    freq.fill(255, 0, 16); // energy only in the vocal range
    const unrestricted = aggregateBands(freq, 8);
    const restricted = aggregateBands(freq, 8, { maxBinIndex: 16 });
    // Unrestricted, most bands average in a long silent tail and read near-zero even though the vocal
    // range is at full scale. Restricted to the vocal range, every band reflects real signal.
    expect(Math.min(...restricted)).toBeGreaterThan(Math.min(...unrestricted));
  });

  it("clamps an out-of-range maxBinIndex to the available bin count", () => {
    const freq = new Uint8Array(16).fill(255);
    const bands = aggregateBands(freq, 4, { maxBinIndex: 999 });
    for (const b of bands) expect(b).toBeCloseTo(1, 5);
  });
});

describe("applyNoiseGate", () => {
  it("zeroes values at or below the floor (ambient room noise never lights the ring)", () => {
    expect(applyNoiseGate([0.05, 0.08], 0.08)).toEqual([0, 0]);
  });

  it("rescales values above the floor back to the full 0–1 range", () => {
    // floor=0.1: a value of 0.55 is (0.55-0.1)/(1-0.1) = 0.5 of the way to full scale.
    const [v] = applyNoiseGate([0.55], 0.1);
    expect(v).toBeCloseTo(0.5, 5);
  });

  it("maps 1 to 1 regardless of floor (peaks are never attenuated by the gate)", () => {
    expect(applyNoiseGate([1], 0.3)[0]).toBeCloseTo(1, 5);
  });

  it("is a no-op at floor 0", () => {
    expect(applyNoiseGate([0.2, 0.7], 0)).toEqual([0.2, 0.7]);
  });
});

describe("smoothBands", () => {
  it("passes the raw signal through unsmoothed on the very first frame (prev = null)", () => {
    expect(smoothBands(null, [0.9, 0.2], 16)).toEqual([0.9, 0.2]);
  });

  it("attacks (rising values) much faster than it releases (falling values) at the same dt", () => {
    const rising = smoothBands([0], [1], 16, { attackMs: 20, releaseMs: 250 });
    const falling = smoothBands([1], [0], 16, { attackMs: 20, releaseMs: 250 });
    // Both move toward their target, but the fast-attack step covers far more distance in one frame
    // than the slow-release step — this asymmetry is what makes the effect feel alive, not laggy.
    expect(rising[0]).toBeGreaterThan(1 - falling[0]);
  });

  it("converges to the target after enough elapsed time regardless of attack/release speed", () => {
    const result = smoothBands([0], [1], 5000, { attackMs: 20, releaseMs: 250 });
    expect(result[0]).toBeCloseTo(1, 3);
  });

  it("is frame-rate independent — two half-steps land at (approximately) the same place as one full step", () => {
    const oneStep = smoothBands([0], [1], 32, { attackMs: 40, releaseMs: 250 })[0];
    const halfStep = smoothBands([0], [1], 16, { attackMs: 40, releaseMs: 250 })[0];
    const twoHalfSteps = smoothBands([halfStep], [1], 16, { attackMs: 40, releaseMs: 250 })[0];
    expect(twoHalfSteps).toBeCloseTo(oneStep, 2);
  });

  it("never produces NaN when dt is zero", () => {
    expect(smoothBands([0.3], [0.9], 0)).toEqual([0.3]);
  });
});

describe("computeLevel", () => {
  it("averages the bands", () => {
    expect(computeLevel([0.2, 0.4, 0.6])).toBeCloseTo(0.4, 5);
  });

  it("returns 0 for an empty band set (no NaN)", () => {
    expect(computeLevel([])).toBe(0);
  });
});

describe("stepOnsetPulse", () => {
  it("retriggers to (near) full strength when the level jumps sharply — a syllable onset", () => {
    const pulse = stepOnsetPulse(0, 0.5, 16, { triggerDelta: 0.15 });
    expect(pulse).toBeGreaterThan(0.9);
  });

  it("does not retrigger on a small delta — ambient jitter shouldn't flash the halo", () => {
    const pulse = stepOnsetPulse(0.1, 0.03, 16, { triggerDelta: 0.15 });
    expect(pulse).toBeLessThanOrEqual(0.1);
  });

  it("decays exponentially toward 0 across frames once triggered", () => {
    let pulse = stepOnsetPulse(0, 0.5, 16, { triggerDelta: 0.15, decayMs: 180 });
    const afterTrigger = pulse;
    pulse = stepOnsetPulse(pulse, 0, 16, { triggerDelta: 0.15, decayMs: 180 });
    expect(pulse).toBeLessThan(afterTrigger);
    expect(pulse).toBeGreaterThan(0);
  });

  it("settles to 0 given enough elapsed time with no further trigger", () => {
    const pulse = stepOnsetPulse(1, 0, 5000, { decayMs: 180 });
    expect(pulse).toBeCloseTo(0, 3);
  });

  it("never produces NaN when dt is zero", () => {
    expect(stepOnsetPulse(0.4, 0, 0)).toBe(0.4);
  });

  it("clamps a retrigger to 1 even if the level delta wildly overshoots the trigger threshold", () => {
    expect(stepOnsetPulse(0, 5, 16, { triggerDelta: 0.15 })).toBeLessThanOrEqual(1);
  });
});

describe("spectrumToConicGradient", () => {
  it("emits a mirrored stop per band on each arm (2n-1 total) spanning the full sweep", () => {
    const g = spectrumToConicGradient([0, 0.5, 1]); // n=3 → 2*3-1 = 5 stops
    expect(g.startsWith("conic-gradient(from -90deg,")).toBe(true); // anchorDeg(90) - 180
    expect(g.match(/,\s*transparent\)/g)).toHaveLength(5);
    expect(g).toContain("0deg");
    expect(g).toContain("360deg");
  });

  it("maps band energy 0→minPct and 1→maxPct", () => {
    const lo = spectrumToConicGradient([0], { colorVar: "--x", fallbackColor: "#fff", minPct: 8, maxPct: 92 });
    expect(lo).toContain("var(--x, #fff) 8%, transparent");
    const hi = spectrumToConicGradient([1], { colorVar: "--x", fallbackColor: "#fff", minPct: 8, maxPct: 92 });
    expect(hi).toContain("92%, transparent");
  });

  it("defaults to the FX accent variable with a vivid fallback so it never washes out or invalidates", () => {
    const g = spectrumToConicGradient([0.5]);
    expect(g).toContain("var(--nl-fx-accent, #22d3ee)");
  });

  it("clamps out-of-range band values", () => {
    const g = spectrumToConicGradient([-5, 5], { minPct: 8, maxPct: 92 });
    expect(g).toContain("8%");
    expect(g).toContain("92%");
    expect(g).not.toMatch(/-\d+%|\d{3,}%/); // no negative or >100 percentages
  });

  it("uses the supplied accent custom properties", () => {
    const g = spectrumToConicGradient([0.5, 0.5], { colorVar: "--my-hue", colorVarAlt: "--my-hue-b" });
    expect(g).toContain("var(--my-hue,");
    expect(g).toContain("var(--my-hue-b,");
    expect(g).not.toContain("--nl-fx-accent");
  });

  it("returns 'none' for an empty band set so the CSS drift fallback applies", () => {
    expect(spectrumToConicGradient([])).toBe("none");
  });

  it("anchors band 0 (bass) at the mic side (90deg — physical right in conic-gradient's clockwise-from-top convention)", () => {
    const g = spectrumToConicGradient([0.5, 0.5]); // n=2, half=1 → stops at r=0,180,360
    const stops = g.slice(g.indexOf(",") + 1).split("deg,");
    expect(stops).toHaveLength(3);
    expect(stops[1]).toContain("var(--nl-fx-accent, #22d3ee)"); // r=180 (relative) = the anchor = band0
    expect(stops[1]).not.toContain("--nl-fx-accent-alt");
  });

  it("mirrors the treble band (n-1) to both ends of the sweep — they meet at the point opposite the mic", () => {
    const g = spectrumToConicGradient([0.5, 0.5]);
    const stops = g.slice(g.indexOf(",") + 1).split("deg,");
    expect(stops[0]).toContain("var(--nl-fx-accent-alt, #a78bfa)"); // r=0
    expect(stops[2]).toContain("var(--nl-fx-accent-alt, #a78bfa)"); // r=360 — same physical point, seamless
  });

  it("supports a custom anchorDeg — `from` is always anchorDeg - 180 so relative r=180 lands on it", () => {
    expect(spectrumToConicGradient([0.5]).startsWith("conic-gradient(from -90deg,")).toBe(true); // default 90
    expect(spectrumToConicGradient([0.5], { anchorDeg: 180 }).startsWith("conic-gradient(from 0deg,")).toBe(true);
  });

  it("degenerates gracefully for a single band — a uniform ring, no mirrored arms, no NaN", () => {
    const g = spectrumToConicGradient([0.7]);
    const stops = g.slice(g.indexOf(",") + 1).split("deg,");
    expect(stops).toHaveLength(2);
    expect(g).not.toContain("NaN");
  });

  it("whitens near-peak bands into a hot filament tip that stays put at its own frequency's position", () => {
    const g = spectrumToConicGradient([1, 0.2]); // band0=1 sits at the anchor (r=180); band1=0.2 is quiet
    const stops = g.slice(g.indexOf(",") + 1).split("deg,");
    expect(stops[1]).toContain("white"); // r=180 = band0 = hot
    expect(stops[0]).not.toContain("white"); // r=0 = band1 = quiet
  });

  it("ignites the filament from moderately-strong bands (Jarvis: peaks read hot early)", () => {
    const g = spectrumToConicGradient([0.8]);
    const stops = g.slice(g.indexOf(",") + 1).split("deg,");
    expect(stops[0]).toContain("white");
  });
});
