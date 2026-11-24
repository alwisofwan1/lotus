import { describe, expect, it } from "vitest";
import {
  REASONING_LEVELS,
  normalizeReasoningLevel,
  reconcileReasoningLevel,
} from "../reasoning-effort";

describe("REASONING_LEVELS", () => {
  it("runs from least to most thinking, because reconcile measures distance along it", () => {
    expect(REASONING_LEVELS).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
      "max",
      "ultra",
    ]);
  });

  it("contains every value Claude Code named as valid", () => {
    // `claude --effort bogus` answers: "Valid values: low, medium, high, xhigh, max."
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(REASONING_LEVELS).toContain(level);
    }
  });

  it("does not contain minimal, which Claude rejects", () => {
    expect(REASONING_LEVELS).not.toContain("minimal");
  });
});

describe("normalizeReasoningLevel", () => {
  it("carries a saved 'minimal' to low, the nearest level that actually applies", () => {
    // Agents and team configs written before 2026-09-10 hold "minimal"; Claude ignores it and
    // silently uses its default, so the stored value was never the effort that ran.
    expect(normalizeReasoningLevel("minimal")).toBe("low");
  });

  it("keeps a level that is already valid", () => {
    expect(normalizeReasoningLevel("xhigh")).toBe("xhigh");
    expect(normalizeReasoningLevel("medium")).toBe("medium");
  });

  it("falls back to medium for anything unrecognised, including empty", () => {
    expect(normalizeReasoningLevel("bogus")).toBe("medium");
    expect(normalizeReasoningLevel("")).toBe("medium");
    expect(normalizeReasoningLevel(undefined)).toBe("medium");
  });

  it("ignores case and surrounding space, because these values come from files", () => {
    expect(normalizeReasoningLevel(" High ")).toBe("high");
  });
});

describe("reconcileReasoningLevel", () => {
  const CLAUDE = ["low", "medium", "high", "xhigh", "max"] as const;

  it("keeps the level when the new model supports it", () => {
    expect(reconcileReasoningLevel("xhigh", CLAUDE)).toBe("xhigh");
  });

  it("drops to the nearest supported level rather than resetting to a default", () => {
    // The user asked for as much thinking as possible; medium would quietly halve it.
    expect(reconcileReasoningLevel("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(reconcileReasoningLevel("none", ["medium", "high"])).toBe("medium");
  });

  it("breaks a tie upward, so a switch never buys less thinking than asked for", () => {
    // "medium" sits exactly between low and high.
    expect(reconcileReasoningLevel("medium", ["low", "high"])).toBe("high");
  });

  it("treats ultracode as xhigh first, the way bb does", () => {
    expect(reconcileReasoningLevel("ultracode", ["low", "xhigh"])).toBe("xhigh");
  });

  it("returns null when the model supports no effort at all", () => {
    // cursor and opencode take no effort flag (`agent-tuning.ts`), so there is nothing to pick —
    // and the caller must hide the field instead of showing a value that will be dropped.
    expect(reconcileReasoningLevel("high", [])).toBeNull();
  });
});
