import { describe, expect, it } from "vitest";
import {
  agentDraftFromDefinition,
  blankAgentDraft,
  buildAgentDefinition,
  isAgentDraftValid,
} from "./agent-draft";

describe("agent-draft", () => {
  it("blank draft is invalid until name and prompt are set", () => {
    const draft = blankAgentDraft();
    expect(isAgentDraftValid(draft)).toBe(false);
    expect(isAgentDraftValid({ ...draft, name: "X" })).toBe(false);
    expect(isAgentDraftValid({ ...draft, name: "X", prompt: "do" })).toBe(true);
    expect(isAgentDraftValid({ ...draft, name: "X", prompt: "do", runner: "custom" })).toBe(false);
    expect(isAgentDraftValid({ ...draft, name: "X", prompt: "do", runner: "custom", runnerCommand: "agent" })).toBe(true);
  });

  it("builds a definition with trimmed fields, parsed skills, and a generated id", () => {
    const def = buildAgentDefinition({
      ...blankAgentDraft(),
      name: "  Coder  ",
      role: " Engineer ",
      model: "claude-opus-4-8",
      prompt: "  build  ",
      skills: "tdd, frontend-design",
      effort: "high",
      permissionMode: "safe",
      runner: "ccs",
    });
    expect(def.name).toBe("Coder");
    expect(def.role).toBe("Engineer");
    expect(def.prompt).toBe("build");
    expect(def.appliedSkills).toEqual(["tdd", "frontend-design"]);
    expect(def.effort).toBe("high");
    expect(def.permissionMode).toBe("safe");
    expect(def.runner).toBe("ccs");
    expect(def.id).toBeTruthy();
  });

  it("preserves an explicit id (edit) and drops a blank role", () => {
    const def = buildAgentDefinition({ ...blankAgentDraft(), name: "A", prompt: "p", role: "  " }, "fixed-id");
    expect(def.id).toBe("fixed-id");
    expect(def.role).toBeUndefined();
  });

  it("round-trips a definition through a draft", () => {
    const def = buildAgentDefinition({ ...blankAgentDraft(), name: "A", prompt: "p", skills: "x, y" }, "id1");
    const draft = agentDraftFromDefinition(def);
    expect(draft.skills).toBe("x, y");
    expect(buildAgentDefinition(draft, def.id).appliedSkills).toEqual(["x", "y"]);
  });
});
