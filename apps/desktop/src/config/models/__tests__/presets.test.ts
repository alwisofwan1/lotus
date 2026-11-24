import { describe, expect, it } from "vitest";

import { MODEL_DEFAULTS } from "../catalog";
import { getCodeChatModelOptions, getPlannerModelsByProvider } from "../presets";

describe("model catalog presets", () => {
  it("projects the Codex models the CLI actually lists, for CodeChat-like CLI surfaces", () => {
    const values = getCodeChatModelOptions("codex").map((model) => model.value);

    // Source: `~/.codex/models_cache.json`, fetched by codex 0.154.0 on 2026-09-10, ordered by
    // the CLI's own `priority`. Every id below appears there with `visibility: "list"`.
    expect(values).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(MODEL_DEFAULTS.codechat.codex).toBe("gpt-6-astra");
  });

  it("no longer offers a Codex model that has been retired", () => {
    const values = getCodeChatModelOptions("codex").map((model) => model.value);

    // Picking one of these asked the CLI for a model that is simply gone.
    for (const retired of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2", "o3", "o4-mini"]) {
      expect(values).not.toContain(retired);
    }
  });

  it("never offers a model the CLI marks hidden", () => {
    const values = getCodeChatModelOptions("codex").map((model) => model.value);

    // `visibility: "hide"` in the cache — internal, not for a picker.
    expect(values).not.toContain("gpt-reserve");
    expect(values).not.toContain("codex-auto-review");
  });

  it("projects planner Codex models from the same catalog", () => {
    const values = getPlannerModelsByProvider("codex").map((model) => model.modelId);

    expect(values[0]).toBe(MODEL_DEFAULTS.plannerCodex.modelId);
    expect(values).toContain("gpt-5.6-sol");
    expect(values).not.toContain("gpt-5.4");
  });

  it("defaults team-builder members to a model that still exists", () => {
    // Was `claude-sonnet-4-6` while the seeded presets already ran Sonnet 5.
    expect(MODEL_DEFAULTS.teamBuilderMember).toBe("claude-sonnet-5");
  });

  it("offers each Claude value once, under its current model's name", () => {
    const options = getCodeChatModelOptions("claude");
    const values = options.map((model) => model.value);
    expect(new Set(values).size).toBe(values.length);
    expect(options.find((model) => model.value === "opus")?.label).toBe("Opus 5");
  });
});
