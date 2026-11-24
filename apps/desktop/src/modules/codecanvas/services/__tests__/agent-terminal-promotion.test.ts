import { describe, expect, it } from "vitest";
import { buildPromotedAgentCommand, buildPromotedAgentPrompt } from "../agent-terminal-promotion";

const baseInput = {
  rolePrompt: "Implement the feature",
  appliedSkills: ["diagnose"],
  context: [{ type: "note", content: "Use ReactFlow" }],
  roster: ["Frontend Specialist", "Backend Specialist"],
  skipPermissions: true,
};

describe("agent-terminal-promotion", () => {
  it("builds a live persona prompt scope (interactive), reusing the shared context assembly", () => {
    const prompt = buildPromotedAgentPrompt(baseInput);

    expect(prompt).toContain("Implement the feature");
    expect(prompt).toContain("Use ReactFlow");
    expect(prompt).toContain("diagnose");
    // Promotion makes a LIVE persona (ADR-0022): the interactive contract, not the headless one-shot one.
    expect(prompt).toContain("A human is watching");
    expect(prompt).not.toContain("There is no human available");
    // Roster is a plan-only concern now (ADR 0010): a non-plan promotion omits it.
    expect(prompt).not.toContain("Frontend Specialist");
  });

  it("prefills an interactive Claude command without submitting it", () => {
    const command = buildPromotedAgentCommand("Ship Bob's feature\nnow", {
      model: "sonnet",
      effort: "high",
      skipPermissions: true,
      submit: false,
    });

    expect(command).toContain("claude");
    expect(command).toContain("--model 'sonnet'");
    expect(command).toContain("--effort 'high'");
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).toContain("'Ship Bob'\\''s feature\nnow'");
    expect(command.endsWith("\r")).toBe(false);
  });

  it("can build a submitted command and omits YOLO when safe mode is selected", () => {
    const command = buildPromotedAgentCommand("Read only", {
      model: "haiku",
      skipPermissions: false,
      submit: true,
    });

    expect(command).toContain("--model 'haiku'");
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command.endsWith("\r")).toBe(true);
  });

  it("defaults to full-access mode when permission mode is omitted", () => {
    const command = buildPromotedAgentCommand("Default access", {
      model: "sonnet",
    });

    expect(command).toContain("--dangerously-skip-permissions");
  });
});
