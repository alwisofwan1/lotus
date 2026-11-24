import { describe, expect, it, vi } from "vitest";
import { resolveTtsProvider, type ResolvableTtsProvider } from "../resolve-tts-provider";
import type { CloudTtsDeps } from "../cloud-tts-provider";

const cloudDeps: CloudTtsDeps = { synthesize: vi.fn(async () => ({ audioBase64: "AA==", mime: "audio/mpeg" })) };
const deps = { cloudDepsFor: vi.fn(() => cloudDeps) };

const providers: ResolvableTtsProvider[] = [
  { id: "browser", kind: "browser", enabled: true },
  { id: "openai", kind: "openai", enabled: true },
  { id: "elevenlabs", kind: "elevenlabs", enabled: false },
];

describe("resolveTtsProvider", () => {
  it("returns the browser provider when active is browser", () => {
    const p = resolveTtsProvider("browser", providers, deps);
    expect(p.kind).toBe("browser");
    expect(p.id).toBe("browser");
  });

  it("returns the browser provider (default) when no active id is set", () => {
    expect(resolveTtsProvider(null, providers, deps).kind).toBe("browser");
    expect(resolveTtsProvider(undefined, providers, deps).kind).toBe("browser");
  });

  it("instantiates a cloud provider for an enabled BYOK provider, wiring its synth deps", () => {
    const p = resolveTtsProvider("openai", providers, deps);
    expect(p.kind).toBe("openai");
    expect(p.id).toBe("openai");
    expect(deps.cloudDepsFor).toHaveBeenCalledWith("openai");
  });

  it("falls back to browser when the chosen provider is disabled", () => {
    expect(resolveTtsProvider("elevenlabs", providers, deps).kind).toBe("browser");
  });

  it("falls back to browser for an unknown provider id or kind", () => {
    expect(resolveTtsProvider("ghost", providers, deps).kind).toBe("browser");
    expect(resolveTtsProvider("x", [{ id: "x", kind: "weird", enabled: true }], deps).kind).toBe("browser");
  });
});

describe("cloud provider speak (front-end wiring complete; Rust synth is the seam)", () => {
  it("requests synthesis then plays the returned audio", async () => {
    const synthesize = vi.fn(async () => ({ audioBase64: "QQ==", mime: "audio/mpeg" }));
    const play = vi.fn(async () => {});
    const p = resolveTtsProvider("openai", providers, { cloudDepsFor: () => ({ synthesize, play }) });
    await p.speak("spawning a codex agent");
    expect(synthesize).toHaveBeenCalledWith("spawning a codex agent", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(play).toHaveBeenCalledWith({ audioBase64: "QQ==", mime: "audio/mpeg" }, expect.any(AbortSignal));
  });

  it("surfaces the Rust stub's error when synthesis is not implemented", async () => {
    const synthesize = vi.fn(async () => {
      throw new Error("TTS provider openai synthesis not implemented yet (BYOK)");
    });
    const p = resolveTtsProvider("openai", providers, { cloudDepsFor: () => ({ synthesize, play: async () => {} }) });
    await expect(p.speak("hi")).rejects.toThrow(/not implemented/i);
  });

  it("treats empty text as a no-op (no synth, no playback)", async () => {
    const synthesize = vi.fn();
    const p = resolveTtsProvider("openai", providers, { cloudDepsFor: () => ({ synthesize, play: async () => {} }) });
    await p.speak("   ");
    expect(synthesize).not.toHaveBeenCalled();
  });
});
