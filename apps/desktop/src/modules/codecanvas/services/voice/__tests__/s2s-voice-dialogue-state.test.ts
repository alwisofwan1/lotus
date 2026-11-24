import { describe, expect, it } from "vitest";
import { applyS2sVoiceDialogueMemory, recordS2sVoiceDialogueTurn } from "../s2s-voice-dialogue-state";

describe("S2S voice dialogue state", () => {
  it("remembers the last resolved target and rewrites pronoun targets", () => {
    const state = recordS2sVoiceDialogueTurn({}, { ok: true, summary: "Dispatch to Bima", speak: "I sent that to Bima." });

    const call = applyS2sVoiceDialogueMemory(
      { callId: "next", name: "dispatch", args: { target: "him", task: "continue with the same approach" } },
      state,
    );

    expect(call.args).toEqual({ target: "Bima", task: "continue with the same approach" });
  });

  it("does not rewrite concrete targets", () => {
    const state = { lastTargetName: "Bima" };
    const call = applyS2sVoiceDialogueMemory({ callId: "next", name: "dispatch", args: { target: "Sena", task: "continue" } }, state);
    expect(call.args.target).toBe("Sena");
  });
});
