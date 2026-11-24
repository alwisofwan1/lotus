import { describe, expect, it, vi } from "vitest";
import { LOTUS_VOICE_TERMS } from "@/modules/codecanvas/services/voice/stt-hint";
import {
  buildCodeVoiceDecoderContext,
  cleanUpCodeVoiceTranscript,
  finalizeCodeVoiceTranscript,
} from "../code-voice-transcript";

describe("buildCodeVoiceDecoderContext", () => {
  it("decodes a Code turn as dictation with personal terms, Lotus's names, then pane names", () => {
    const context = buildCodeVoiceDecoderContext({ personalTerms: ["Flow Trader"], expectedLanguages: [] }, ["Juno", "Shell"]);

    expect(context.prompt).toContain("Technical dictation");
    expect(context.keywords).toEqual(["Flow Trader", ...LOTUS_VOICE_TERMS, "Juno", "Shell"]);
  });

  it("leaves the language to the model unless the user chose languages in Voice settings", () => {
    expect(buildCodeVoiceDecoderContext({ personalTerms: [], expectedLanguages: [] }, []).languages).toEqual([]);
    expect(buildCodeVoiceDecoderContext({ personalTerms: [], expectedLanguages: ["id", "en"] }, []).languages)
      .toEqual(["id", "en"]);
  });
});

describe("finalizeCodeVoiceTranscript", () => {
  it("applies the user's corrections from both stages", () => {
    const text = finalizeCodeVoiceTranscript("di ratus voice pakai cloud", {
      replacements: [
        { id: "a", variants: ["di ratus"], replacement: "Lotus", timing: "before-ai", enabled: true },
        { id: "b", variants: ["cloud"], replacement: "Claude", timing: "after-ai", enabled: true },
        { id: "c", variants: ["voice"], replacement: "VOICE", timing: "both", enabled: false },
      ],
    });

    expect(text).toBe("Lotus voice pakai Claude");
  });

  it("returns the transcript unchanged without rules", () => {
    expect(finalizeCodeVoiceTranscript("run the tests", { replacements: [] })).toBe("run the tests");
  });
});

describe("cleanUpCodeVoiceTranscript", () => {
  const raw = "di ratus voice saat ini eh saya ingin optimasi untuk outputnya agar lebih intuitive dan juga world class level";
  const accuracy = {
    personalTerms: ["Flow Trader"],
    replacements: [{ id: "a", variants: ["di ratus"], replacement: "Lotus", timing: "before-ai" as const, enabled: true }],
  };

  it("cleans up a long turn with the user's corrections applied first and keeps what was said", async () => {
    const callModel = vi.fn<(prompt: string, signal?: AbortSignal) => Promise<string>>(async () =>
      "Lotus Voice saat ini saya ingin optimasi untuk outputnya agar lebih intuitive dan juga world class level.");
    const result = await cleanUpCodeVoiceTranscript(raw, { accuracy, paneNames: ["Juno"], mode: "clean", callModel });

    expect(callModel.mock.calls[0]?.[0]).toContain("Transcript: Lotus voice saat ini");
    expect(callModel.mock.calls[0]?.[0]).toContain("Flow Trader, Lotus, Lotus Voice");
    expect(callModel.mock.calls[0]?.[0]).toContain("never translate");
    expect(result.text).toBe("Lotus Voice saat ini saya ingin optimasi untuk outputnya agar lebih intuitive dan juga world class level.");
    expect(result.spoken).toBe("Lotus voice saat ini eh saya ingin optimasi untuk outputnya agar lebih intuitive dan juga world class level");
  });

  it("falls back to what was said when the model fails", async () => {
    const result = await cleanUpCodeVoiceTranscript(raw, {
      accuracy,
      paneNames: [],
      mode: "clean",
      callModel: async () => { throw new Error("nl_complete[config]: no key"); },
    });

    expect(result.text).toBe(result.spoken);
  });
});
