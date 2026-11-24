import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPcmWorkletSource,
  PCM_CAPTURE_PROCESSOR_NAME,
  PCM_CAPTURE_WORKLET_URL,
} from "../pcm-capture-worklet-source";
import { resamplePcm16, int16ToBase64 } from "../pcm-capture-dsp";

describe("buildPcmWorkletSource", () => {
  const src = buildPcmWorkletSource();

  it("registers the 'pcm-capture' processor", () => {
    expect(src).toContain('registerProcessor("pcm-capture"');
    expect(src).toContain("extends AudioWorkletProcessor");
  });

  it("binds the DSP to fixed const names (minification-proof — not referenced by mangled name)", () => {
    expect(src).toContain("const resamplePcm16 =");
    expect(src).toContain("const int16ToBase64 =");
  });

  it("embeds runnable DSP: the const bindings extracted from the source compute correctly", () => {
    // Reconstruct just the two DSP consts in a fresh scope (the class body needs AudioWorkletProcessor,
    // absent in jsdom) and confirm the embedded code actually runs and matches the originals.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const make = new Function(`
      const resamplePcm16 = ${resamplePcm16.toString()};
      const int16ToBase64 = ${int16ToBase64.toString()};
      return { resamplePcm16, int16ToBase64 };
    `)() as { resamplePcm16: typeof resamplePcm16; int16ToBase64: typeof int16ToBase64 };

    const input = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 4));
    const pcm = make.resamplePcm16(input, 48000, 16000);
    expect(Array.from(pcm)).toEqual(Array.from(resamplePcm16(input, 48000, 16000)));
    expect(make.int16ToBase64(pcm)).toBe(int16ToBase64(pcm));
  });
});

// The asset the app actually loads. Next serves `public/` at the root, so the URL maps to this file.
const WORKLET_ASSET = path.resolve(__dirname, "../../../../public", PCM_CAPTURE_WORKLET_URL.slice(1));

describe("committed worklet asset", () => {
  it("is exactly buildPcmWorkletSource() — rerun this file with -u after changing the source or DSP", async () => {
    await expect(buildPcmWorkletSource()).toMatchFileSnapshot(WORKLET_ASSET);
  });

  it("registers a processor that posts the same PCM16 base64 as the tested DSP", () => {
    const registered: Record<string, new (options: unknown) => { process(inputs: Float32Array[][]): boolean }> = {};
    const posted: string[] = [];
    class FakeAudioWorkletProcessor {
      port = { postMessage: (data: string) => posted.push(data) };
    }
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", readFileSync(WORKLET_ASSET, "utf8"))(
      FakeAudioWorkletProcessor,
      (name: string, ctor: (typeof registered)[string]) => (registered[name] = ctor),
      48000,
    );

    const Processor = registered[PCM_CAPTURE_PROCESSOR_NAME];
    expect(Processor).toBeDefined();
    const processor = new Processor({ processorOptions: { targetRate: 24000, chunkMs: 40 } });
    // 40 ms at 48 kHz = 1920 frames = 15 render quanta of 128.
    const audio = Float32Array.from({ length: 1920 }, (_, i) => Math.sin(i / 8) * 0.5);
    for (let at = 0; at < audio.length; at += 128) {
      expect(processor.process([[audio.subarray(at, at + 128)]])).toBe(true);
    }

    expect(posted).toEqual([int16ToBase64(resamplePcm16(audio, 48000, 24000))]);
  });
});
