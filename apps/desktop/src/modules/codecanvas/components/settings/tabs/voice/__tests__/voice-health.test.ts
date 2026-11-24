import { describe, expect, it } from "vitest";
import type { EngineSummary } from "@/modules/codecanvas/services/voice/engine-summary";
import { classifyVoiceError, describeLastTest, voiceCapabilityStatus } from "../voice-health";

const openai: EngineSummary = { id: "openai", name: "OpenAI", kind: "openai", needsKey: true, hasKey: true, ready: true };
const builtIn: EngineSummary = { id: "browser", name: "Built-in", kind: "browser", needsKey: false, hasKey: false, ready: true };

describe("classifyVoiceError", () => {
  it("sorts the real error shapes into the card's fixes", () => {
    expect(classifyVoiceError("stt provider 'openai' has no API key configured")).toBe("needs-key");
    expect(classifyVoiceError("OpenAI transcription failed (HTTP 401): Incorrect API key provided")).toBe("key-refused");
    expect(classifyVoiceError("NotAllowedError: Permission denied")).toBe("mic-blocked");
    expect(classifyVoiceError("network timeout")).toBe("failed");
  });
});

describe("voiceCapabilityStatus", () => {
  it("is Ready only after a passing test for a cloud engine; a missing key says so", () => {
    expect(voiceCapabilityStatus({ capability: "listen", summary: openai })).toMatchObject({ tone: "ok", label: "Key saved" });
    expect(
      voiceCapabilityStatus({ capability: "listen", summary: openai, lastTest: { engineId: "openai", at: 0, ok: true } }),
    ).toMatchObject({ tone: "ok", label: "Ready" });
    expect(voiceCapabilityStatus({ capability: "listen", summary: builtIn })).toMatchObject({ label: "Ready" });
    expect(voiceCapabilityStatus({ capability: "listen", summary: { ...openai, hasKey: false, ready: false } })).toMatchObject({
      tone: "warn",
      label: "Needs a key",
      problem: "needs-key",
    });
    expect(voiceCapabilityStatus({ capability: "listen", summary: null })).toMatchObject({ label: "Not set up" });
  });

  it("turns a failed test for the same engine into its problem, and ignores one for another engine", () => {
    const refused = { engineId: "openai", at: 0, ok: false, problem: "key-refused" as const };
    expect(voiceCapabilityStatus({ capability: "speak", summary: openai, lastTest: refused })).toMatchObject({
      tone: "err",
      label: "Key refused",
      why: expect.stringContaining("Spoken replies stay silent"),
    });
    expect(voiceCapabilityStatus({ capability: "listen", summary: builtIn, lastTest: refused })).toMatchObject({ tone: "ok" });
    expect(
      voiceCapabilityStatus({ capability: "listen", summary: builtIn, lastTest: { engineId: "browser", at: 0, ok: false, problem: "mic-blocked" } }),
    ).toMatchObject({ label: "Mic blocked", problem: "mic-blocked" });
  });

  it("shows Testing… while a test runs and Off for Live until it is ready", () => {
    expect(voiceCapabilityStatus({ capability: "listen", summary: openai, testing: true })).toMatchObject({ tone: "busy", label: "Testing…" });
    expect(voiceCapabilityStatus({ capability: "live", summary: { ...openai, ready: false } })).toMatchObject({ tone: "off", label: "Off" });
    expect(voiceCapabilityStatus({ capability: "live", summary: null }).problem).toBeUndefined();
  });
});

describe("describeLastTest", () => {
  it("reads like the mockup", () => {
    expect(describeLastTest(null, 0)).toBe("Never");
    expect(describeLastTest({ engineId: "x", at: 0, ok: true, ms: 600 }, 120_000)).toBe("2 min ago · 0.6 s");
    expect(describeLastTest({ engineId: "x", at: 0, ok: false }, 10)).toBe("just now · failed");
  });
});
