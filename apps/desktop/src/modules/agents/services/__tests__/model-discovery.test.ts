import { describe, expect, it } from "vitest";
import { formatModelLabel, mergeDiscoveredEffortOptions, mergeDiscoveredModelOptions } from "../model-discovery";

describe("formatModelLabel", () => {
  it("formats known aliases", () => {
    expect(formatModelLabel("sonnet")).toBe("Sonnet");
    expect(formatModelLabel("opus")).toBe("Opus");
    expect(formatModelLabel("haiku")).toBe("Haiku");
  });

  it("capitalizes brand tokens", () => {
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(formatModelLabel("claude-opus-4-6")).toBe("Claude Opus 4.6");
  });

  it("handles GPT model identifiers", () => {
    expect(formatModelLabel("gpt-5.4-mini")).toBe("GPT 5.4 Mini");
    expect(formatModelLabel("gpt-5.3-codex-spark")).toBe("GPT 5.3 Codex Spark");
  });

  it("merges consecutive numeric segments with dots", () => {
    expect(formatModelLabel("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
    expect(formatModelLabel("model-3-2-turbo")).toBe("Model 3.2 Turbo");
  });

  it("preserves segments already containing dots", () => {
    expect(formatModelLabel("gpt-5.4")).toBe("GPT 5.4");
  });

  it("capitalizes unknown tokens", () => {
    expect(formatModelLabel("my-custom-model")).toBe("My Custom Model");
  });

  it("returns empty string as-is", () => {
    expect(formatModelLabel("")).toBe("");
  });
});

describe("mergeDiscoveredModelOptions", () => {
  it("preserves built-in labels while appending discovered models with formatted labels", () => {
    expect(
      mergeDiscoveredModelOptions(
        [
          { label: "Sonnet", value: "sonnet" },
          { label: "Opus", value: "opus" },
        ],
        ["sonnet", "claude-sonnet-4-6", "haiku"]
      )
    ).toEqual([
      { label: "Sonnet", value: "sonnet" },
      { label: "Opus", value: "opus" },
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "Haiku", value: "haiku" },
    ]);
  });

  it("filters empty and duplicate discovered values", () => {
    expect(
      mergeDiscoveredModelOptions(
        [{ label: "GPT-5", value: "gpt-5" }],
        ["", "gpt-5", "gpt-5-codex", "gpt-5-codex"]
      )
    ).toEqual([
      { label: "GPT-5", value: "gpt-5" },
      { label: "GPT 5 Codex", value: "gpt-5-codex" },
    ]);
  });
});

describe("mergeDiscoveredEffortOptions", () => {
  it("appends discovered effort options not in the base list", () => {
    expect(
      mergeDiscoveredEffortOptions(["low", "medium", "high"], ["max"])
    ).toEqual(["low", "medium", "high", "max"]);
  });

  it("deduplicates discovered efforts already in base", () => {
    expect(
      mergeDiscoveredEffortOptions(["low", "medium", "high"], ["medium", "high", "max"])
    ).toEqual(["low", "medium", "high", "max"]);
  });

  it("filters invalid effort values", () => {
    expect(
      mergeDiscoveredEffortOptions(["low", "medium"], ["max", "turbo", "ultra"])
    ).toEqual(["low", "medium", "max"]);
  });

  it("returns base unchanged when no discovered efforts", () => {
    expect(
      mergeDiscoveredEffortOptions(["low", "medium", "high"], [])
    ).toEqual(["low", "medium", "high"]);
  });
});
