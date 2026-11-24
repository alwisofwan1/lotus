import { describe, it, expect } from "vitest";
import {
  DEFAULT_AGENTS,
  ENGINEERING_TEAM,
  FEATURE_PIPELINE,
  coderDefinition,
} from "../default-agents";
import type { AgentDefinition } from "../../types/canvas";

const userAgent = (id: string): AgentDefinition => ({
  id,
  name: "My Agent",
  model: "claude-sonnet-5",
  prompt: "do things",
  appliedSkills: [],
  updatedAt: 1,
});

const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-4-5";

describe("default agent roster", () => {
  it("ships fifteen agents, one per shipped avatar slug, with unique stable ids", () => {
    expect(DEFAULT_AGENTS).toHaveLength(15);
    const ids = DEFAULT_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(15);
    expect(ids.every((id) => id.startsWith("agent-"))).toBe(true);
  });

  it("assigns slash-command skills to pipeline agents and leaves the rest empty", () => {
    const skills = (slug: string) => DEFAULT_AGENTS.find((a) => a.id === `agent-${slug}`)?.appliedSkills ?? [];
    expect(skills("researcher")).toEqual(["grill-with-docs"]);
    expect(skills("coder")).toEqual(["tdd", "diagnose", "simplify"]);
    expect(skills("reviewer")).toEqual(["security-review", "code-review"]);
    const noSkills = DEFAULT_AGENTS.filter((a) => !["agent-researcher", "agent-coder", "agent-reviewer"].includes(a.id));
    expect(noSkills.every((a) => a.appliedSkills.length === 0)).toBe(true);
    expect(DEFAULT_AGENTS.every((a) => a.prompt.trim().length > 200)).toBe(true);
  });

  it("applies the tiered model policy (Opus for judgment/gate, Haiku for the writer)", () => {
    const model = (slug: string) => DEFAULT_AGENTS.find((a) => a.id === `agent-${slug}`)?.model;
    for (const slug of ["planner", "architect", "reviewer", "security", "critic"]) {
      expect(model(slug)).toBe(OPUS);
    }
    expect(model("documentation")).toBe(HAIKU);
  });

  it("marks exactly the inspection roles read-only (permissionMode safe)", () => {
    const safe = DEFAULT_AGENTS.filter((a) => a.permissionMode === "safe").map((a) => a.id).sort();
    expect(safe).toEqual(
      ["agent-analyst", "agent-critic", "agent-researcher", "agent-reviewer", "agent-security"].sort(),
    );
  });

  it("bakes the parseable plan.md contract into the Planner so it emits a syncable plan", () => {
    const planner = DEFAULT_AGENTS.find((a) => a.id === "agent-planner");
    expect(planner?.prompt).toContain("docs/agent-team/plan.md");
    expect(planner?.prompt).toContain("- [ ] task");
  });

  it("derives the team-dispatch subset from the same definition objects (no copies)", () => {
    expect(ENGINEERING_TEAM.map((a) => a.id)).toEqual([
      "agent-planner",
      "agent-architect",
      "agent-coder",
      "agent-reviewer",
      "agent-qa",
      "agent-devops",
      "agent-documentation",
    ]);
    for (const member of ENGINEERING_TEAM) {
      expect(DEFAULT_AGENTS).toContain(member);
    }
  });

  it("defines the feature pipeline in execution order with correct agents", () => {
    expect(FEATURE_PIPELINE.map((a) => a.id)).toEqual([
      "agent-researcher",
      "agent-planner",
      "agent-critic",
      "agent-coder",
      "agent-reviewer",
    ]);
    for (const member of FEATURE_PIPELINE) {
      expect(DEFAULT_AGENTS).toContain(member);
    }
  });

  it("exposes the Coder definition for Task single-mode dispatch", () => {
    expect(coderDefinition.id).toBe("agent-coder");
    expect(coderDefinition).toBe(DEFAULT_AGENTS.find((a) => a.id === "agent-coder"));
  });

});
