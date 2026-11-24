import { describe, expect, it } from "vitest";
import { meaningfulSpawnBrief } from "../spawn-brief-guard";

describe("meaningfulSpawnBrief — drops a brief that is just the spawn request restated", () => {
  it("drops the exact text that shipped this bug", () => {
    // "spawn cloud code agent and codex agent" → the model split the utterance and handed each
    // fragment back as that agent's first task. Both fragments say nothing but the runner's name.
    expect(meaningfulSpawnBrief("cloud code agent", "claude")).toBeNull();
    expect(meaningfulSpawnBrief("codex agent", "codex")).toBeNull();
  });

  it.each([
    ["claude code agent", "claude"],
    ["Claude Code", "claude"],
    ["a codex agent", "codex"],
    ["spawn two claude agents", "claude"],
    ["open a new terminal", "claude"],
    ["start the agent", "codex"],
  ])("drops %s", (brief, runner) => {
    expect(meaningfulSpawnBrief(brief, runner)).toBeNull();
  });

  it("drops the Indonesian phrasings too — the user speaks both", () => {
    expect(meaningfulSpawnBrief("buka dua agen claude", "claude")).toBeNull();
    expect(meaningfulSpawnBrief("bikin agen codex", "codex")).toBeNull();
  });

  it("drops empty and whitespace", () => {
    expect(meaningfulSpawnBrief("", "claude")).toBeNull();
    expect(meaningfulSpawnBrief("   ", "claude")).toBeNull();
    expect(meaningfulSpawnBrief(undefined, "claude")).toBeNull();
  });

  it("drops a brief naming a CUSTOM runner, not just the built-ins", () => {
    // A user-defined runner must not become a blind spot the moment someone adds one.
    expect(meaningfulSpawnBrief("qwen agent", "qwen")).toBeNull();
  });
});

describe("meaningfulSpawnBrief — keeps real work", () => {
  it.each([
    ["fix the auth bug", "claude"],
    ["review the pricing page", "codex"],
    ["spawn a codex agent to fix the failing tests", "codex"],
    ["perbaiki bug login", "claude"],
    // "code" is a stopword because of "Claude Code"; a real task that merely starts with it must
    // still survive on the strength of the rest.
    ["code review the auth module", "claude"],
  ])("keeps %s", (brief, runner) => {
    expect(meaningfulSpawnBrief(brief, runner)).toBe(brief);
  });

  it("returns the trimmed original, not a normalized rewrite", () => {
    // The agent should receive what the user actually said, not the guard's lowercased scratch copy.
    expect(meaningfulSpawnBrief("  Fix the Auth bug  ", "claude")).toBe("Fix the Auth bug");
  });
});
