import { describe, expect, it } from "vitest";
import { SHARED_NARRATION_RULES, SPOKEN_DELIVERY_RULES, composeNarrationPrompt } from "../narration-rules";

describe("SPOKEN_DELIVERY_RULES is a true subset of the full policy", () => {
  const bulletsOf = (block: string) =>
    block.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "));

  it("carries no clause the full policy does not also carry", () => {
    // The realtime session pays for its instructions on every connect, so S2S gets a trimmed
    // block. Two hand-maintained copies drift; this is the gate that stops them.
    const full = bulletsOf(SHARED_NARRATION_RULES);
    const orphans = bulletsOf(SPOKEN_DELIVERY_RULES).filter((clause) => !full.includes(clause));

    expect(orphans).toEqual([]);
  });

  it("is genuinely smaller than the full policy", () => {
    // Guards the degenerate pass: a subset equal to the whole set satisfies the check above while
    // defeating the reason the subset exists.
    expect(bulletsOf(SPOKEN_DELIVERY_RULES).length).toBeGreaterThan(0);
    expect(bulletsOf(SPOKEN_DELIVERY_RULES).length).toBeLessThan(bulletsOf(SHARED_NARRATION_RULES).length);
  });
});

describe("composeNarrationPrompt", () => {
  it("orders the sections rules → persona → task", () => {
    const text = composeNarrationPrompt({
      rules: "RULES_BLOCK",
      persona: "PERSONA_BLOCK",
      task: "TASK_BLOCK",
    });

    expect(text.indexOf("RULES_BLOCK")).toBeLessThan(text.indexOf("PERSONA_BLOCK"));
    expect(text.indexOf("PERSONA_BLOCK")).toBeLessThan(text.indexOf("TASK_BLOCK"));
  });

  it("drops a blank section instead of leaving a gap — a raw persona must not produce a double break", () => {
    // Heard's naive `rules + "\n\n" + persona + "\n\n" + task` emits "RULES\n\n\n\nTASK" when the
    // persona is the pass-through `raw` one. Sections are joined, not concatenated.
    const text = composeNarrationPrompt({ rules: "RULES_BLOCK", persona: "   ", task: "TASK_BLOCK" });

    expect(text).toBe("RULES_BLOCK\n\nTASK_BLOCK");
  });
});
