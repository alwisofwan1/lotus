import { describe, expect, it, vi } from "vitest";
import { resolveSttProvider, type ResolvableSttProvider } from "../resolve-stt-provider";
import type { CloudSttDeps, SttRecording } from "../cloud-stt-provider";

const fakeRecording: SttRecording = { stop: vi.fn(async () => ({ base64: "QQ==", mime: "audio/webm" })), cancel: vi.fn() };
const cloudDeps: CloudSttDeps = { transcribe: vi.fn(async () => "hello world"), record: vi.fn(async () => fakeRecording) };
const deps = { cloudDepsFor: vi.fn(() => cloudDeps) };

const providers: ResolvableSttProvider[] = [
  { id: "browser", kind: "browser", enabled: true },
  { id: "openai", kind: "openai", enabled: true },
  { id: "deepgram", kind: "deepgram", enabled: false },
];

describe("resolveSttProvider", () => {
  it("returns the browser provider when active is browser or unset", () => {
    expect(resolveSttProvider("browser", providers, deps).kind).toBe("browser");
    expect(resolveSttProvider(null, providers, deps).kind).toBe("browser");
  });

  it("instantiates a cloud provider for an enabled BYOK provider, wiring its transcribe deps", () => {
    const p = resolveSttProvider("openai", providers, deps);
    expect(p.kind).toBe("openai");
    expect(p.id).toBe("openai");
    expect(deps.cloudDepsFor).toHaveBeenCalledWith("openai");
  });

  it("falls back to browser when the chosen provider is disabled or unknown", () => {
    expect(resolveSttProvider("deepgram", providers, deps).kind).toBe("browser");
    expect(resolveSttProvider("ghost", providers, deps).kind).toBe("browser");
  });

  it("honors an explicit Browser selection even when a keyed cloud provider is enabled", () => {
    const keyed: ResolvableSttProvider[] = [
      { id: "browser", kind: "browser", enabled: true },
      { id: "openai", kind: "openai", enabled: true, apiKey: "***" },
    ];

    expect(resolveSttProvider("browser", keyed, deps).kind).toBe("browser");
  });

  it("does not hijack an explicit browser selection when no cloud provider has a key", () => {
    expect(resolveSttProvider("browser", providers, deps).kind).toBe("browser");
  });
});

describe("cloud STT provider capture flow (front-end wiring complete; Rust transcribe is the seam)", () => {
  it("records on start, then transcribes the captured audio on stop", async () => {
    const stop = vi.fn(async () => ({ base64: "QQ==", mime: "audio/webm" }));
    const transcribe = vi.fn(async () => "spawn a claude agent");
    const p = resolveSttProvider("openai", providers, {
      cloudDepsFor: () => ({ transcribe, record: async () => ({ stop, cancel: vi.fn() }) }),
    });
    await p.start();
    const text = await p.stop();
    expect(stop).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledWith("QQ==", "audio/webm");
    expect(text).toBe("spawn a claude agent");
  });

  it("surfaces the Rust stub's error when transcription is not implemented", async () => {
    const p = resolveSttProvider("openai", providers, {
      cloudDepsFor: () => ({
        transcribe: async () => {
          throw new Error("STT provider openai transcription not implemented yet (BYOK)");
        },
        record: async () => ({ stop: async () => ({ base64: "QQ==", mime: "audio/webm" }), cancel: vi.fn() }),
      }),
    });
    await p.start();
    await expect(p.stop()).rejects.toThrow(/not implemented/i);
  });
});
