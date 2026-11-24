import { describe, expect, it } from "vitest";
import { getAgentModelOptions, getModelDefaultEffort, getModelEfforts } from "../presets";

describe("getAgentModelOptions", () => {
  it("offers the current Claude family and none of the retired ids", () => {
    const ids = getAgentModelOptions("claude").map((o) => o.id);

    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-sonnet-5");
    // These are what the Agents dialog showed on 2026-09-10 while the team presets already ran 5.
    expect(ids).not.toContain("claude-opus-4-8");
    expect(ids).not.toContain("claude-sonnet-4-6");
    expect(ids).not.toContain("claude-opus-4-6");
  });

  it("gives every option a label a person can read", () => {
    for (const option of getAgentModelOptions("claude")) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.label).not.toBe(option.id);
    }
  });

  it("offers codex its own models, not Claude ids", () => {
    const ids = getAgentModelOptions("codex").map((o) => o.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => !id.startsWith("claude-"))).toBe(true);
  });

  it("offers exactly the codex models the CLI itself lists, in its own priority order", () => {
    // Source: `~/.codex/models_cache.json`, written by codex 0.154.0 on 2026-09-10 — the CLI's own
    // fetched list, ordered by its `priority` field.
    expect(getAgentModelOptions("codex").map((o) => o.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("drops the codex ids that no longer exist", () => {
    const ids = getAgentModelOptions("codex").map((o) => o.id);
    // These were in the catalog but are absent from the CLI's list, so choosing one asked for a
    // model that is simply gone.
    for (const retired of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"]) {
      expect(ids).not.toContain(retired);
    }
  });

  it("never offers a model the CLI marks hidden", () => {
    const ids = getAgentModelOptions("codex").map((o) => o.id);
    // `visibility: "hide"` in the cache — internal, not for a picker.
    expect(ids).not.toContain("gpt-reserve");
    expect(ids).not.toContain("codex-auto-review");
  });

  it("offers nothing for a provider whose model flag Lotus does not know", () => {
    // `agent-tuning.ts` drops --model for these, so a dropdown would be a promise it cannot keep.
    expect(getAgentModelOptions("cursor")).toEqual([]);
  });
});

describe("getModelEfforts", () => {
  it("gives a Claude model exactly the levels the CLI named as valid", () => {
    // $ claude --effort bogus → "Valid values: low, medium, high, xhigh, max."
    expect(getModelEfforts("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("resolves by shorthand too, since that is what reaches the CLI", () => {
    expect(getModelEfforts("opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("returns an empty list for a model with no effort knob", () => {
    expect(getModelEfforts("cursor-auto")).toEqual([]);
  });

  it("returns an empty list for a model it has never heard of, rather than guessing", () => {
    expect(getModelEfforts("some-future-model")).toEqual([]);
  });

  it("never offers minimal, which Claude rejects outright", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5", "opus", "sonnet"]) {
      expect(getModelEfforts(id)).not.toContain("minimal");
    }
  });
});

describe("codex efforts, per model", () => {
  it("gives each codex model exactly the levels the CLI recorded for it", () => {
    // Straight from `~/.codex/models_cache.json`: the sets genuinely differ per model, which is
    // why a single app-wide effort list could never be right.
    expect(getModelEfforts("gpt-6-astra")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(getModelEfforts("gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(getModelEfforts("gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getModelEfforts("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("carries each model's own default effort, which is not always medium", () => {
    expect(getModelDefaultEffort("gpt-6-astra")).toBe("low");
    expect(getModelDefaultEffort("gpt-5.6-sol")).toBe("low");
    expect(getModelDefaultEffort("gpt-5.6-terra")).toBe("medium");
  });

  it("offers ultra only where the CLI does", () => {
    expect(getModelEfforts("gpt-5.6-terra")).toContain("ultra");
    expect(getModelEfforts("gpt-5.6-luna")).not.toContain("ultra");
    // Claude's CLI named its five valid values and ultra was not among them.
    expect(getModelEfforts("claude-opus-5")).not.toContain("ultra");
  });
});
