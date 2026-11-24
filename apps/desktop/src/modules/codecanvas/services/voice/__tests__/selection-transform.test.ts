import { describe, expect, it, vi } from "vitest";
import { buildSelectionTransformPrompt, transformSelection } from "../selection-transform";

describe("buildSelectionTransformPrompt", () => {
  it("embeds the instruction and the snippet, and forbids answering/commentary", () => {
    const p = buildSelectionTransformPrompt("make this bullets", "milk eggs bread").toLowerCase();
    expect(p).toContain("make this bullets");
    expect(p).toContain("milk eggs bread");
    expect(p).toMatch(/do not answer|no preamble|only the transformed/);
  });
});

describe("transformSelection", () => {
  it("returns the model's transformed text, unwrapped of stray quotes", async () => {
    const callModel = vi.fn().mockResolvedValue('  "- milk\\n- eggs"  ');
    expect(await transformSelection("milk eggs", "bullets", callModel)).toBe("- milk\\n- eggs");
  });

  it("FAILS CLOSED (null) on model error — never overwrites the selection with garbage", async () => {
    const callModel = vi.fn().mockRejectedValue(new Error("down"));
    expect(await transformSelection("milk eggs", "bullets", callModel)).toBeNull();
  });

  it("returns null (no-op) for an empty selection or empty instruction", async () => {
    const callModel = vi.fn();
    expect(await transformSelection("   ", "bullets", callModel)).toBeNull();
    expect(await transformSelection("milk", "  ", callModel)).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });

  it("returns null when the model produces empty output", async () => {
    const callModel = vi.fn().mockResolvedValue("   ");
    expect(await transformSelection("milk", "bullets", callModel)).toBeNull();
  });
});
