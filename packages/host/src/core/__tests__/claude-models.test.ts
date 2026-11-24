import { describe, it, expect } from "vitest";
import { CLAUDE_MODELS, resolveClaudeModel } from "../claude-models.js";

describe("CLAUDE_MODELS", () => {
  it("offers the current tiers as aliases, newest first (each resolves to the latest)", () => {
    expect(CLAUDE_MODELS.map((m) => m.slug)).toEqual(["fable", "opus", "sonnet", "haiku"]);
  });

  it("names no pinned id, so no entry can age with a release", () => {
    // `claude --help`: an alias resolves to the latest model of its tier. A `claude-opus-5`
    // here would be a promise this file cannot keep past the next one.
    for (const model of CLAUDE_MODELS) {
      expect(model.slug).not.toMatch(/^claude-/);
      expect(model.slug).not.toMatch(/\d/);
    }
  });

  it("offers nothing the account may not have", () => {
    // Mythos 5 is invitation-only, and an alias the account cannot use is a spawn that
    // fails on the machine rather than in the picker.
    expect(CLAUDE_MODELS.map((m) => m.slug)).not.toContain("mythos");
  });
});

describe("resolveClaudeModel", () => {
  it("keeps a valid selection", () => {
    expect(resolveClaudeModel("opus")).toBe("opus");
    expect(resolveClaudeModel("haiku")).toBe("haiku");
  });

  it("defaults to sonnet when nothing is selected", () => {
    expect(resolveClaudeModel(undefined)).toBe("sonnet");
  });

  it("falls back to sonnet for an unknown alias", () => {
    expect(resolveClaudeModel("gpt-5")).toBe("sonnet");
  });
});
