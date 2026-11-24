import { describe, it, expect, vi } from "vitest";
import type { ResolvableSttProvider } from "../resolve-stt-provider";

// Capture the options the resolver hands each adapter, so we can assert it forwards the spectrum
// callback down BOTH mic-owning paths: streaming (Deepgram realtime) AND batch (MediaRecorder — what
// the fallback wrapper lands on, and what OpenAI/custom BYOK use).
const captured = vi.hoisted(() => ({
  streaming: null as null | { onSpectrum?: unknown },
  cloud: null as null | { onSpectrum?: unknown },
}));
vi.mock("../streaming-stt-provider", () => ({
  createStreamingSttProvider: (id: string, opts: { onSpectrum?: unknown }) => {
    captured.streaming = opts;
    return { id, kind: "deepgram", start: async () => {}, stop: async () => "", cancel: () => {}, isAvailable: () => true };
  },
}));
vi.mock("../cloud-stt-provider", () => ({
  createCloudSttProvider: (id: string, kind: string, _deps: unknown, opts: { onSpectrum?: unknown } = {}) => {
    captured.cloud = opts;
    return { id, kind, start: async () => {}, stop: async () => "", cancel: () => {}, isAvailable: () => true };
  },
}));

import { resolveSttProvider } from "../resolve-stt-provider";

const providers: ResolvableSttProvider[] = [
  { id: "deepgram", kind: "deepgram", enabled: true, apiKey: "***" },
  { id: "openai", kind: "openai", enabled: true, apiKey: "***" },
];
const cloudDeps = () => ({ transcribe: vi.fn(async () => ""), record: vi.fn() as never });

describe("resolveSttProvider — spectrum wiring", () => {
  it("forwards onSpectrum to the streaming provider on the desktop Deepgram path", () => {
    const onSpectrum = vi.fn();
    resolveSttProvider("deepgram", providers, { cloudDepsFor: cloudDeps, preferStreaming: true, onSpectrum });
    expect(captured.streaming?.onSpectrum).toBe(onSpectrum);
  });

  it("forwards onSpectrum to the batch cloud provider (fallback + OpenAI/custom captures)", () => {
    const onSpectrum = vi.fn();
    resolveSttProvider("openai", providers, { cloudDepsFor: cloudDeps, onSpectrum });
    expect(captured.cloud?.onSpectrum).toBe(onSpectrum);
  });
});
