import { describe, it, expect } from "vitest";
import { downsampleToPcm16, pcm16ToBase64 } from "../streaming-stt-provider";

describe("downsampleToPcm16", () => {
  it("converts unit-range floats to full-scale Int16", () => {
    const out = downsampleToPcm16(new Float32Array([0, 1, -1, 0.5]), 16000);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0x7fff);
    expect(out[2]).toBe(-0x8000);
    // Int16Array stores truncate toward zero (no rounding): 0.5 * 32767 = 16383.5 → 16383.
    expect(out[3]).toBe(Math.trunc(0.5 * 0x7fff));
  });

  it("clamps out-of-range samples to Int16 bounds", () => {
    const out = downsampleToPcm16(new Float32Array([2, -2]), 16000);
    expect(out[0]).toBe(0x7fff);
    expect(out[1]).toBe(-0x8000);
  });

  it("downsamples 48 kHz to ~16 kHz (one third the samples)", () => {
    const input = new Float32Array(48000).fill(0.25);
    const out = downsampleToPcm16(input, 48000);
    expect(out.length).toBe(16000);
    // Averaging a constant signal preserves it (truncated to Int16).
    expect(out[0]).toBe(Math.trunc(0.25 * 0x7fff));
  });

  it("returns empty for empty input", () => {
    expect(downsampleToPcm16(new Float32Array([]), 48000).length).toBe(0);
  });
});

describe("pcm16ToBase64", () => {
  it("round-trips little-endian Int16 bytes", () => {
    const pcm = new Int16Array([0, 1, -1, 256]);
    const b64 = pcm16ToBase64(pcm);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(new Int16Array(bytes.buffer)).toEqual(pcm);
  });
});
