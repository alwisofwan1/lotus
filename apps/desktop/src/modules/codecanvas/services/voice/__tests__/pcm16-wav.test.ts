import { describe, expect, it } from "vitest";
import { concatInt16, encodeWavPcm16, WAV_HEADER_BYTES } from "../pcm16-wav";

function ascii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe("encodeWavPcm16", () => {
  it("writes a canonical 44-byte PCM WAV header for mono 16-bit at the given rate", () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const buf = encodeWavPcm16(samples, 24000);
    const view = new DataView(buf);

    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + samples.length * 2);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint32(28, true)).toBe(24000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("preserves the little-endian sample payload exactly", () => {
    const samples = new Int16Array([12345, -12345]);
    const view = new DataView(encodeWavPcm16(samples, 16000));
    expect(view.getInt16(WAV_HEADER_BYTES, true)).toBe(12345);
    expect(view.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(-12345);
  });
});

describe("concatInt16", () => {
  it("joins chunks in order into one contiguous buffer (gapless)", () => {
    const out = concatInt16([new Int16Array([1, 2]), new Int16Array([3]), new Int16Array([4, 5])]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns an empty buffer for no chunks", () => {
    expect(concatInt16([]).length).toBe(0);
  });
});
