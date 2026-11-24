/**
 * Pure DSP for the AudioWorklet mic-capture path. These two functions are the single source of truth
 * for resampling + PCM16 base64 encoding: they are unit-tested HERE and, via `.toString()` embedding
 * (see `pcm-capture-worklet-source.ts`), the SAME function bodies run inside the AudioWorklet — which
 * has no module system and no `btoa`. They must therefore be **self-contained** (no closure/module
 * references, no external constants) so `.toString()` reconstructs a working function standalone.
 */

/** Downsample mono Float32 audio at `inputRate` to Int16 PCM at `targetRate` with a cheap
 *  window-averaging anti-alias. At/below target it just clamps+converts (no upsampling). The clamp is
 *  inlined (not a helper) so the function is self-contained for `.toString()` embedding. */
export function resamplePcm16(
  input: Float32Array,
  inputRate: number,
  targetRate: number,
): Int16Array {
  if (inputRate <= targetRate || input.length === 0) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputRate / targetRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      n++;
    }
    const avg = n > 0 ? sum / n : input[start] ?? 0;
    const s = Math.max(-1, Math.min(1, avg));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Worklet-safe base64 of a little-endian PCM16 buffer. No `btoa` (absent in AudioWorkletGlobalScope),
 *  no large spread. Self-contained for `.toString()` embedding. */
export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const len = bytes.length;
  let out = "";
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + chars[n & 63];
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + "=";
  }
  return out;
}
