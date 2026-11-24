import { resamplePcm16, int16ToBase64 } from "./pcm-capture-dsp";

/**
 * Builds the AudioWorklet module source. It is committed as the static asset at
 * `PCM_CAPTURE_WORKLET_URL` (`public/voice/pcm-capture-worklet.js`) and loaded from the app's own
 * origin, because the production CSP's `script-src` has no `blob:` and WebKit checks a worklet module
 * against `script-src`: a Blob URL failed every release capture with "Not allowed by CSP". The asset
 * is written by a file-snapshot test, so it cannot drift from this function — after changing it or
 * the DSP, run `bunx vitest run -u src/modules/voice-core/__tests__/pcm-capture-worklet-source.test.ts`.
 *
 * The worklet global scope has no module system, so the DSP can't be imported; instead the tested
 * pure functions are embedded by `.toString()` and bound to FIXED const names. Binding to a const
 * (rather than referencing the function by its declared name) is what makes this minification-proof:
 * a bundler may rename `resamplePcm16` → `a`, but `const resamplePcm16 = function a(){…}` still binds
 * the fixed name the processor calls. The functions are verified self-contained by the DSP unit tests.
 *
 * The processor accumulates 128-frame render quanta at the context `sampleRate`, and every ~`chunkMs`
 * of audio resamples that window to `targetRate` PCM16, base64-encodes it, and posts it to the main
 * thread — so downsample + encode never touch the main thread.
 */
export const PCM_CAPTURE_PROCESSOR_NAME = "pcm-capture";

/** Same-origin path of the committed worklet asset (Next serves `public/` at the root). */
export const PCM_CAPTURE_WORKLET_URL = "/voice/pcm-capture-worklet.js";

export function buildPcmWorkletSource(): string {
  return `
const resamplePcm16 = ${resamplePcm16.toString()};
const int16ToBase64 = ${int16ToBase64.toString()};

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this._targetRate = o.targetRate || 16000;
    // Default ~40ms of audio per posted chunk (equal-or-better latency than the old 4096-sample path).
    this._chunkFrames = o.chunkFrames || Math.max(1, Math.round(sampleRate * ((o.chunkMs || 40) / 1000)));
    this._buf = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      const merged = new Float32Array(this._buf.length + ch.length);
      merged.set(this._buf, 0);
      merged.set(ch, this._buf.length);
      this._buf = merged;
    }
    while (this._buf.length >= this._chunkFrames) {
      const chunk = this._buf.subarray(0, this._chunkFrames);
      const pcm = resamplePcm16(chunk, sampleRate, this._targetRate);
      if (pcm.length) this.port.postMessage(int16ToBase64(pcm));
      this._buf = this._buf.slice(this._chunkFrames);
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(PCM_CAPTURE_PROCESSOR_NAME)}, PcmCaptureProcessor);
`;
}
