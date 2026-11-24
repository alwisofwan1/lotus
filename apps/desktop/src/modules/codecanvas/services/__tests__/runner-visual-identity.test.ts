import { describe, expect, it } from "vitest";
import { resolveRunnerVisualIdentity } from "../runner-visual-identity";

describe("resolveRunnerVisualIdentity", () => {
  it("shows a custom Claude-family runner with its registry label and the Claude mark", () => {
    expect(resolveRunnerVisualIdentity({
      runner: "custom",
      customRunner: {
        id: "custom-hss",
        name: "HSS",
        claudeFamily: true,
      },
    })).toEqual({
      label: "HSS",
      accessibleLabel: "HSS",
      mark: {
        kind: "logo",
        src: "/assets/ai-logo/Claude.svg",
      },
      // A custom Claude-family CLI wears the Claude logo, so it wears the Claude colour too —
      // brand follows the mark, not the runner id.
      brand: "claude",
    });
  });

  it("shows the registered Pi runner with the Pi glyph", () => {
    expect(resolveRunnerVisualIdentity({
      runner: "custom",
      customRunner: {
        id: "custom-pi",
        name: "Pi",
        claudeFamily: false,
      },
    })).toEqual({
      label: "Pi",
      accessibleLabel: "Pi",
      mark: {
        kind: "glyph",
        value: "π",
      },
      // No vendor logo, so no vendor colour to borrow: the Fleet row keeps its node-type colour.
      brand: "generic",
    });
  });

  it("shows an unknown custom runner with a terminal CLI mark", () => {
    expect(resolveRunnerVisualIdentity({
      runner: "custom",
      customRunner: {
        id: "custom-local-agent",
        name: "Local Agent",
        claudeFamily: false,
      },
    })).toEqual({
      label: "Local Agent",
      accessibleLabel: "Local Agent",
      mark: { kind: "terminal" },
      brand: "generic",
    });
  });

  // The `brand` column is the point of the fourth argument existing at all: claude/ccs/csp are
  // three runners sharing ONE vendor, which is exactly why colour keys off brand rather than the
  // runner id. Asserting it per row is what stops a new Claude-family runner being given its own
  // colour by accident.
  it.each([
    ["claude", "Claude Code", "Claude", "/assets/ai-logo/Claude.svg", "claude"],
    ["ccs", "ccs", "Claude", "/assets/ai-logo/Claude.svg", "claude"],
    ["csp", "csp", "Claude", "/assets/ai-logo/Claude.svg", "claude"],
    ["codex", "Codex", "Codex", "/assets/ai-logo/ChatGPT.svg", "chatgpt"],
    ["cursor", "Cursor Agent", "Cursor", "/assets/ai-logo/Cursor.svg", "cursor"],
  ] as const)("keeps the %s runner's existing branded identity", (runner, label, accessibleLabel, src, brand) => {
    expect(resolveRunnerVisualIdentity({ runner })).toEqual({
      label,
      accessibleLabel,
      mark: { kind: "logo", src },
      brand,
    });
  });
});
