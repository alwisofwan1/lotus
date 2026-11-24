import { describe, expect, it } from "vitest";

import type { ChatModel } from "../../runtime/chat-runtime-client";
import { currentOption, modelName, modelOptions } from "../ChatModel";

// Trimmed from a live `supportedModels()` read, 2026-10-28.
const MODELS: ChatModel[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", description: "Best for everyday" },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Efficient" },
];

describe("model picker", () => {
  it("folds Claude's default into the model it resolves to and divides off pinned versions", () => {
    const options = modelOptions(MODELS);
    expect(options.map((o) => [o.model.value, o.isDefault, o.startsOlder])).toEqual([
      ["opus", true, false],
      ["sonnet", false, false],
      ["claude-opus-4-8", false, true],
      ["claude-sonnet-4-6", false, false],
    ]);
  });

  it("finds the current model by what was picked or by what Claude reported", () => {
    const options = modelOptions(MODELS);
    expect(currentOption(options, null)?.model.value).toBe("opus");
    expect(currentOption(options, "default")?.model.value).toBe("opus");
    expect(currentOption(options, "sonnet")?.model.value).toBe("sonnet");
    expect(currentOption(options, "claude-sonnet-5-5")?.model.value).toBe("sonnet");
    expect(currentOption(options, "claude-haiku-9")).toBeNull();
  });

  it("names a model from the list, or from its id before the list arrives", () => {
    expect(modelName(MODELS, "claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelName([], "claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName([], "sonnet")).toBe("sonnet");
    expect(modelName([], null)).toBeNull();
  });
});
