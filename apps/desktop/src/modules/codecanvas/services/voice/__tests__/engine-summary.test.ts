import { describe, it, expect } from "vitest";
import { summarizeActiveEngine } from "../engine-summary";

// The Voice settings revamp (plans/voice-settings-revamp) shows the ACTIVE engine per capability as a
// pill ("Whisper · Key set") and in the Loop hero. summarizeActiveEngine resolves the active provider
// from a registry and reports whether it is ready to use. It is capability-agnostic — the same shape
// backs STT, TTS and S2S — so it lives as one pure, tested helper.
describe("summarizeActiveEngine", () => {
  it("returns a ready, keyless summary for the built-in browser provider", () => {
    const reg = {
      activeProvider: "browser",
      providers: [{ id: "browser", name: "Browser (Web Speech)", kind: "browser", builtin: true, enabled: true }],
    };
    expect(summarizeActiveEngine(reg)).toEqual({
      id: "browser",
      name: "Browser (Web Speech)",
      kind: "browser",
      needsKey: false,
      hasKey: false,
      ready: true,
    });
  });

  it("marks a cloud provider with a stored key as ready", () => {
    const reg = {
      activeProvider: "whisper",
      providers: [{ id: "whisper", name: "Whisper", kind: "openai", builtin: false, enabled: true, apiKey: "sk-live-abc" }],
    };
    expect(summarizeActiveEngine(reg)).toMatchObject({ id: "whisper", name: "Whisper", needsKey: true, hasKey: true, ready: true });
  });

  it("treats the redaction sentinel '***' as a stored key (keys never cross IPC in the clear)", () => {
    const reg = {
      activeProvider: "whisper",
      providers: [{ id: "whisper", name: "Whisper", kind: "openai", builtin: false, enabled: true, apiKey: "***" }],
    };
    expect(summarizeActiveEngine(reg)).toMatchObject({ hasKey: true, ready: true });
  });

  it("reports a cloud provider with no key as not ready", () => {
    const missing = { activeProvider: "whisper", providers: [{ id: "whisper", name: "Whisper", kind: "openai", builtin: false, enabled: true }] };
    const empty = { activeProvider: "whisper", providers: [{ id: "whisper", name: "Whisper", kind: "openai", builtin: false, enabled: true, apiKey: "" }] };
    expect(summarizeActiveEngine(missing)).toMatchObject({ needsKey: true, hasKey: false, ready: false });
    expect(summarizeActiveEngine(empty)).toMatchObject({ hasKey: false, ready: false });
  });

  it("treats a whitespace-only key as no key", () => {
    const reg = { activeProvider: "whisper", providers: [{ id: "whisper", name: "Whisper", kind: "openai", builtin: false, enabled: true, apiKey: "   " }] };
    expect(summarizeActiveEngine(reg)).toMatchObject({ hasKey: false, ready: false });
  });

  it("is not ready when the active provider is disabled, even with a key", () => {
    const reg = { activeProvider: "whisper", providers: [{ id: "whisper", name: "Whisper", kind: "openai", builtin: false, enabled: false, apiKey: "sk-x" }] };
    expect(summarizeActiveEngine(reg)).toMatchObject({ ready: false });
  });

  it("returns null when the active provider id is absent (e.g. S2S default 'grok' with no providers)", () => {
    expect(summarizeActiveEngine({ activeProvider: "grok", providers: [] })).toBeNull();
  });

  it("returns null for a null/undefined registry (browser-dev or unloaded)", () => {
    expect(summarizeActiveEngine(null)).toBeNull();
    expect(summarizeActiveEngine(undefined)).toBeNull();
  });
});
