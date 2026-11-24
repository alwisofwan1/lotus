import { describe, expect, it } from "vitest";
import { applyVoiceReplacements, type VoiceReplacementRule } from "../voice-replacements";

const rules: VoiceReplacementRule[] = [
  {
    id: "claude",
    variants: ["cloud code", "clod code", "claud code"],
    replacement: "Claude Code",
    timing: "before-ai",
    enabled: true,
  },
  {
    id: "agent-file",
    variants: ["agents dot md"],
    replacement: "AGENTS.md",
    timing: "both",
    enabled: true,
  },
  {
    id: "airpods",
    variants: ["air pods"],
    replacement: "AirPods",
    timing: "after-ai",
    enabled: true,
  },
];

describe("applyVoiceReplacements", () => {
  it("applies case-insensitive literal variants at the configured pipeline stage", () => {
    expect(applyVoiceReplacements("Ask CLOD CODE to read agents dot md and air pods", rules, "before-ai"))
      .toBe("Ask Claude Code to read AGENTS.md and air pods");
    expect(applyVoiceReplacements("Ask cloud code to read agents dot md and air pods", rules, "after-ai"))
      .toBe("Ask cloud code to read AGENTS.md and AirPods");
  });

  it("respects Unicode-aware word boundaries and prefers the longest overlapping variant", () => {
    const overlap: VoiceReplacementRule[] = [
      { id: "short", variants: ["cloud"], replacement: "Claude", timing: "both", enabled: true },
      { id: "long", variants: ["cloud code"], replacement: "Claude Code", timing: "both", enabled: true },
    ];

    expect(applyVoiceReplacements("cloud code, cloudy, megacloud, cloud.", overlap, "before-ai"))
      .toBe("Claude Code, cloudy, megacloud, Claude.");
  });

  it("ignores disabled, empty, and oversized rules instead of accepting unbounded user input", () => {
    const unsafe: VoiceReplacementRule[] = [
      { id: "off", variants: ["alpha"], replacement: "beta", timing: "both", enabled: false },
      { id: "empty", variants: [""], replacement: "invented", timing: "both", enabled: true },
      { id: "huge", variants: ["x".repeat(200)], replacement: "y", timing: "both", enabled: true },
    ];

    expect(applyVoiceReplacements(`alpha ${"x".repeat(200)}`, unsafe, "before-ai"))
      .toBe(`alpha ${"x".repeat(200)}`);
  });
});
