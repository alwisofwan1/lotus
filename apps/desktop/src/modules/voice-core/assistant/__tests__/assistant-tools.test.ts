import { describe, expect, it, vi } from "vitest";
import { assistantResult, executeAssistantTool, firstSentences, withAssistantTools } from "../assistant-tools";
import { parseAssistantSettings, DEFAULT_ASSISTANT_SETTINGS } from "../assistant-settings";
import type { AssistantBrain } from "../assistant-brain";

const LONG = "Two commits landed. Both are about voice. One fixes the mute pill. The other adds a chime.";

describe("assistantResult", () => {
  it("follows the readback setting for answers", () => {
    expect(assistantResult({ kind: "answer", text: LONG }, "off")).toEqual({ ok: true, summary: "Two commits landed.", speak: "", silent: true });
    expect(assistantResult({ kind: "answer", text: LONG }, "short").speak).toBe("Two commits landed. Both are about voice.");
    expect(assistantResult({ kind: "answer", text: LONG }, "full").speak).toBe(LONG);
  });

  it("always speaks a risky-action question", () => {
    const result = assistantResult({ kind: "approval", action: "run the command git push" }, "off");
    expect(result.silent).toBeUndefined();
    expect(result.speak).toBe("This will run the command git push. Should I go ahead?");
  });

  it("caps a long sentence", () => {
    expect(firstSentences("a".repeat(500)).length).toBe(240);
  });
});

describe("executeAssistantTool", () => {
  const brain = (overrides: Partial<AssistantBrain>): AssistantBrain => ({
    prepare: vi.fn(async () => {}),
    ask: vi.fn(async () => ({ kind: "answer" as const, text: "Done." })),
    decide: vi.fn(async () => ({ kind: "answer" as const, text: "Pushed." })),
    awaitingApproval: () => false,
    dispose: () => {},
    ...overrides,
  });

  it("routes ask and answer, and never throws", async () => {
    const b = brain({});
    await executeAssistantTool({ name: "work_on", args: { request: " status? ", new_topic: true } }, { brain: b, cwd: "/repo", readback: "short" });
    expect(b.ask).toHaveBeenCalledWith("/repo", "status?", { newTopic: true });
    await executeAssistantTool({ name: "confirm_action", args: { approve: "yes" } }, { brain: b, cwd: "/repo", readback: "short" });
    expect(b.decide).toHaveBeenCalledWith(false);

    expect(await executeAssistantTool({ name: "work_on", args: {} }, { brain: b, cwd: "/repo", readback: "short" })).toMatchObject({ ok: false });
    const broken = brain({ ask: vi.fn(async () => Promise.reject(new Error("boom"))) });
    expect(await executeAssistantTool({ name: "work_on", args: { request: "x" } }, { brain: broken, cwd: "/repo", readback: "off" })).toMatchObject({ ok: false, error: "boom" });
  });
});

describe("withAssistantTools", () => {
  it("adds both tools and the instruction", () => {
    const out = withAssistantTools({ instructions: "base", tools: [] });
    expect(out.tools.map((tool) => tool.name)).toEqual(["work_on", "confirm_action"]);
    expect(out.instructions).toMatch(/^base\n\n.*work_on/);
  });
});

describe("parseAssistantSettings", () => {
  it("falls back field by field", () => {
    expect(parseAssistantSettings(null)).toEqual(DEFAULT_ASSISTANT_SETTINGS);
    expect(parseAssistantSettings("not json")).toEqual(DEFAULT_ASSISTANT_SETTINGS);
    expect(parseAssistantSettings(JSON.stringify({ brain: "codex", readback: "loud", askBeforeRisky: false }))).toEqual({
      ...DEFAULT_ASSISTANT_SETTINGS,
      // Codex was withdrawn as the brain: a stored one moves to Claude.
      brain: "claude",
      confirm: "off",
    });
    expect(parseAssistantSettings(JSON.stringify({ askBeforeRisky: true })).confirm).toBe("auto");
    expect(parseAssistantSettings(JSON.stringify({ confirm: "always" })).confirm).toBe("always");
    expect(parseAssistantSettings(JSON.stringify({ brain: "gemini" })).brain).toBe("off");
  });
});
