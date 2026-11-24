import { describe, expect, it } from "vitest";
import type { NlCommandContext } from "../../canvas-nl-command";
import { assessS2sVoiceAgentTargetConfidence } from "../s2s-voice-target-confidence";

function ctx(): NlCommandContext {
  return {
    roster: [
      { id: "sena", name: "Sena", status: "running", aliases: ["Claude 1", "Cloud one"] },
      { id: "nara", name: "Nara", status: "running", aliases: ["Claude 2", "Cloud two"] },
      { id: "bima", name: "Bima", status: "running", aliases: ["Claude 3", "Cloud three", "claude-3"] },
      { id: "bayu", name: "Bayu", status: "running", aliases: ["Codex", "Codex 1"] },
    ],
    nodeRefs: [],
  };
}

describe("S2S voice target confidence", () => {
  it("treats visible names and explicit ordinals as high confidence", () => {
    expect(assessS2sVoiceAgentTargetConfidence("Bima", ctx())).toEqual({ level: "high", label: "Bima", reason: "visible-exact" });
    expect(assessS2sVoiceAgentTargetConfidence("claude-3", ctx())).toEqual({ level: "high", label: "Bima", reason: "explicit-ordinal" });
  });

  it("treats fuzzy visible-name matches as medium confidence", () => {
    expect(assessS2sVoiceAgentTargetConfidence("Bma", ctx())).toEqual({ level: "medium", label: "Bima", reason: "fuzzy" });
  });

  it("flags vague aliases with multiple candidates as ambiguous", () => {
    expect(assessS2sVoiceAgentTargetConfidence("Claude", ctx())).toEqual({
      level: "low",
      reason: "ambiguous",
      candidates: ["Sena", "Nara", "Bima"],
    });
  });
});
