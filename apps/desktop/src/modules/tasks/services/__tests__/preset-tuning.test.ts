import { describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "@/config/models";
import {
  chosenChoice,
  composePresetArgs,
  overriddenByExtra,
  presetEfforts,
  presetFamily,
  presetModelChoices,
  presetSummary,
  readPresetTuning,
} from "@/modules/tasks/services/preset-tuning";

describe("which CLI a preset runs", () => {
  it("treats ccs and csp profiles as Claude", () => {
    expect(presetFamily("ccs acme")).toBe("claude");
    expect(presetFamily("csp")).toBe("claude");
    expect(presetFamily("codex")).toBe("codex");
    expect(presetFamily("gh copilot")).toBe("other");
  });
});

describe("reading an old preset's flags into the pickers", () => {
  it("opens the real saved preset as Full access, not Ask first", () => {
    expect(readPresetTuning("ccs acme", "--dangerously-skip-permissions")).toEqual({
      model: null,
      effort: null,
      permission: "yolo",
      extra: "",
    });
  });

  it("lifts Claude's model and effort in both spellings and keeps the rest verbatim", () => {
    expect(readPresetTuning("claude", "--model=opus --verbose --effort high --add-dir ../x")).toEqual({
      model: "opus",
      effort: "high",
      permission: "safe",
      extra: "--verbose --add-dir ../x",
    });
  });

  it("lifts codex's -m and its effort override, quoted or not", () => {
    expect(readPresetTuning("codex", `-m gpt-5.6-sol -c model_reasoning_effort="xhigh" --search`)).toEqual({
      model: "gpt-5.6-sol",
      effort: "xhigh",
      permission: "safe",
      extra: "--search",
    });
    expect(readPresetTuning("codex", "--config model_reasoning_effort=low").effort).toBe("low");
  });

  it("leaves an effort the CLI would ignore in place instead of correcting it", () => {
    expect(readPresetTuning("claude", "--effort bogus")).toMatchObject({ effort: null, extra: "--effort bogus" });
  });

  it("does not lift flags for an agent Lotus cannot tune", () => {
    expect(readPresetTuning("cursor", "--model gpt-5")).toEqual({
      model: null,
      effort: null,
      permission: null,
      extra: "--model gpt-5",
    });
    expect(readPresetTuning("gemini", "--yolo").permission).toBe("yolo");
  });
});

describe("writing the pickers back as flags", () => {
  it("round-trips a Claude preset", () => {
    const args = composePresetArgs("claude", { model: "sonnet", effort: "high", permission: "yolo", extra: "--verbose" });
    expect(args).toBe("--model sonnet --effort high --dangerously-skip-permissions --verbose");
    expect(readPresetTuning("claude", args)).toEqual({ model: "sonnet", effort: "high", permission: "yolo", extra: "--verbose" });
  });

  it("writes codex effort as --config, which Automations' Rust path does not swallow as -c", () => {
    expect(composePresetArgs("codex", { model: "gpt-5.6-sol", effort: "medium", permission: "safe", extra: "" })).toBe(
      "--model gpt-5.6-sol --config model_reasoning_effort=medium",
    );
  });

  it("keeps a ccs profile written in args ahead of every flag", () => {
    expect(composePresetArgs("ccs", { model: "opus", effort: null, permission: "yolo", extra: "acme --verbose" })).toBe(
      "acme --model opus --dangerously-skip-permissions --verbose",
    );
  });

  it("writes nothing it cannot honour", () => {
    expect(composePresetArgs("opencode", { model: "x", effort: "high", permission: "yolo", extra: "--foo" })).toBe("--foo");
  });

  it("says which extra flags override a picker", () => {
    expect(overriddenByExtra("claude", "--model opus --verbose")).toEqual(["--model"]);
    expect(overriddenByExtra("claude", "--verbose")).toEqual([]);
  });
});

describe("what the pickers offer", () => {
  it("lists the catalog's Agents models, then discovered ones, then a saved one nobody offers any more", () => {
    const choices = presetModelChoices("claude", ["sonnet", "claude-fable-5"], "sonnet[1m]");
    const values = choices.map((choice) => choice.value);
    expect(values.slice(0, 3)).toEqual(["opus", "sonnet", "haiku"]);
    expect(values).toContain("claude-fable-5");
    expect(choices.at(-1)).toMatchObject({ value: "sonnet[1m]", stale: true });
    expect(values.filter((value) => value === "sonnet")).toHaveLength(1);
  });

  it("offers no models for an agent without a model flag", () => {
    expect(presetModelChoices("gemini", ["gemini-3"])).toEqual([]);
  });

  it("offers only the efforts the model accepts", () => {
    expect(presetEfforts("codex", "gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(presetEfforts("claude", null)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(presetEfforts("cursor", null)).toEqual([]);
  });

  it("summarises a row in words", () => {
    expect(presetSummary("claude", "--model sonnet --effort high")).toEqual({ text: "Sonnet 5 · High", fullAccess: false });
    expect(presetSummary("ccs acme", "--dangerously-skip-permissions")).toEqual({ text: "CLI default", fullAccess: true });
  });
});

describe("the catalog", () => {
  it("has no id twice", () => {
    const ids = MODEL_CATALOG.map((entry) => entry.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

describe("the CLI's own model list", () => {
  const live = [
    { value: "opus", label: "Opus 5.5", efforts: ["low", "high", "max"], resolvesTo: "claude-opus-5-5" },
    { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] },
    { value: "claude-opus-5", label: "Opus 5", efforts: ["low", "high"] },
  ];

  it("replaces the catalog, in the CLI's order and names", () => {
    const choices = presetModelChoices("claude", [], null, undefined, live);
    expect(choices.map((c) => c.label)).toEqual(["Opus 5.5", "Haiku 4.5", "Opus 5"]);
    expect(choices[0].resolvesTo).toBe("claude-opus-5-5");
  });

  it("ticks only the exact row, not the pinned twin of an alias", () => {
    const choices = presetModelChoices("claude", [], "opus", undefined, live);
    expect(chosenChoice(choices, "opus")?.label).toBe("Opus 5.5");
    expect(chosenChoice(choices, "claude-opus-5")?.label).toBe("Opus 5");
  });

  it("takes each model's levels from its row, so a model with none gets no reasoning row", () => {
    const choices = presetModelChoices("claude", [], null, undefined, live);
    expect(presetEfforts("claude", "claude-haiku-4-5-20251001", choices)).toEqual([]);
    expect(presetEfforts("claude", "opus", choices)).toEqual(["low", "high", "max"]);
  });

  it("names a preset's model the way the CLI does when it has answered", () => {
    expect(presetSummary("claude", "--model opus", (m) => (m === "opus" ? "Opus 5.5" : undefined)).text).toBe("Opus 5.5");
  });
});
