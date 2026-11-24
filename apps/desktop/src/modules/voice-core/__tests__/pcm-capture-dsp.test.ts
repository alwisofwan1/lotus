import { describe, expect, it } from "vitest";
import { int16ToBase64, resamplePcm16 } from "../pcm-capture-dsp";
import { pcm16ToBase64, downsampleToPcm16 } from "../streaming-stt-provider";

describe("int16ToBase64", () => {
  it("base64-encodes little-endian PCM16 bytes (worklet-safe, no btoa)", () => {
    // 256 = 0x0100 → LE bytes [0x00, 0x01]; 32767 = 0x7fff → [0xff, 0x7f]
    const pcm = Int16Array.from([256, 32767]);
    const expected = btoa(String.fromCharCode(0x00, 0x01, 0xff, 0x7f));
    expect(int16ToBase64(pcm)).toBe(expected);
  });

  it("is byte-exact with the existing pcm16ToBase64 (the on-the-wire guarantee)", () => {
    // Cover both non-negative and negative samples (sign → high byte), across every padding remainder.
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      const pcm = Int16Array.from({ length: n }, (_, i) => (i % 2 === 0 ? i * 321 : -(i * 257)));
      expect(int16ToBase64(pcm)).toBe(pcm16ToBase64(pcm));
    }
  });

  it("returns an empty string for an empty buffer", () => {
    expect(int16ToBase64(new Int16Array(0))).toBe("");
  });
});

describe("resamplePcm16", () => {
  const sine = (len: number, rate: number, freq = 220) =>
    Float32Array.from({ length: len }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate));

  it("downsamples 48kHz→16kHz byte-exactly like the existing downsampleToPcm16", () => {
    const input = sine(4096, 48000);
    expect(Array.from(resamplePcm16(input, 48000, 16000))).toEqual(
      Array.from(downsampleToPcm16(input, 48000, 16000)),
    );
  });

  it("downsamples 48kHz→24kHz byte-exactly like the existing downsampleToPcm16", () => {
    const input = sine(4096, 48000);
    expect(Array.from(resamplePcm16(input, 48000, 24000))).toEqual(
      Array.from(downsampleToPcm16(input, 48000, 24000)),
    );
  });

  it("clamps + converts without resampling when the input rate is at or below the target", () => {
    const input = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]); // 2/-2 clamp to full-scale
    expect(Array.from(resamplePcm16(input, 16000, 16000))).toEqual(
      Array.from(downsampleToPcm16(input, 16000, 16000)),
    );
  });

  it("returns an empty buffer for empty input", () => {
    expect(resamplePcm16(new Float32Array(0), 48000, 16000).length).toBe(0);
  });
});

// The AudioWorklet has no module system: the worklet source is built by embedding these functions'
// `.toString()`. That only works if each function is fully self-contained (no closure/module refs).
// Reconstructing via `new Function` (a fresh global scope, like the worklet) proves it.
describe("DSP functions are self-contained (safe for .toString() worklet embedding)", () => {
  const reconstruct = <T>(fn: T): T =>
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(`return (${(fn as unknown as { toString(): string }).toString()})`)() as T;

  it("resamplePcm16 runs standalone with identical output", () => {
    const standalone = reconstruct(resamplePcm16);
    const input = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i / 5));
    expect(Array.from(standalone(input, 48000, 16000))).toEqual(
      Array.from(resamplePcm16(input, 48000, 16000)),
    );
  });

  it("int16ToBase64 runs standalone with identical output", () => {
    const standalone = reconstruct(int16ToBase64);
    const pcm = Int16Array.from({ length: 50 }, (_, i) => (i % 2 ? -i * 200 : i * 200));
    expect(standalone(pcm)).toBe(int16ToBase64(pcm));
  });
});
