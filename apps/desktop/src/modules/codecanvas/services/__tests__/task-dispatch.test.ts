import { describe, it, expect, beforeEach } from "vitest";
import { buildTaskBrief, composeAgentPrompt, composeTaskPrompt, planTaskDispatch, planTeamLaunch, type TaskObjective } from "../task-dispatch";
import type { AgentDefinition } from "../../types/canvas";

const task: TaskObjective = { title: "Add login", description: "Implement OAuth login" };

const richTask: TaskObjective = {
  title: "TKT-722 EC-29C: Isolate upload failures",
  intent: "Ensure a failed storage charge never starts dunning.",
  when: "this-week",
  acceptanceCriteria: [
    { id: "a", text: "Storage items tagged with charge_type", done: true },
    { id: "b", text: "A storage failure never starts dunning", done: false },
  ],
  taskId: "30a83136-ba90-403b-9dec-e613e6513501",
  taskWorkspaceId: "ws-main",
};

describe("buildTaskBrief", () => {
  it("renders title, humanized Timeline, Intent, and done-reflecting criteria", () => {
    const out = buildTaskBrief(richTask);
    expect(out).toContain("# TKT-722 EC-29C: Isolate upload failures");
    expect(out).toContain("Timeline: this week");
    expect(out).toContain("## Intent\nEnsure a failed storage charge never starts dunning.");
    expect(out).toContain("## Acceptance criteria\n- [x] Storage items tagged with charge_type\n- [ ] A storage failure never starts dunning");
    expect(out).not.toContain("curl"); // brief itself carries no callback
  });

  it("falls back to description for Intent and omits empty sections", () => {
    expect(buildTaskBrief({ title: "T", description: "the goal" })).toBe("# T\n\n## Intent\nthe goal");
    expect(buildTaskBrief({ title: "T" })).toBe("# T");
  });
});

describe("composeTaskPrompt", () => {
  it("appends the completion callback, addressed by workspace, when the task is linked", () => {
    const out = composeTaskPrompt(richTask);
    expect(out).toContain(`PATCH "$AGENT_CANVAS_API/api/tasks/30a83136-ba90-403b-9dec-e613e6513501?workspaceId=ws-main"`);
    expect(out).toContain('-d \'{"status":"in-review"}\'');
    expect(out).toContain("Authorization: Bearer $AGENT_CANVAS_API_KEY");
    expect(out).not.toContain("manualReviewDone");
    expect(out).not.toContain("/api/task/update");
  });

  it("omits the callback for a canvas-only task (no taskId)", () => {
    expect(composeTaskPrompt({ title: "T", intent: "g" })).not.toContain("curl");
  });

  it("omits the callback when the workspace is unknown — the route would refuse it with 400", () => {
    expect(composeTaskPrompt({ ...richTask, taskWorkspaceId: undefined })).not.toContain("curl");
  });

  it("encodes the workspace id in the callback query", () => {
    expect(composeTaskPrompt({ ...richTask, taskWorkspaceId: "a b&c" })).toContain("?workspaceId=a%20b%26c");
  });

  it("Copy mode has no persona; Run/Team mode appends persona before the callback", () => {
    expect(composeTaskPrompt(richTask)).not.toContain("PERSONA");
    const withPersona = composeTaskPrompt(richTask, { persona: "PERSONA" });
    expect(withPersona).toContain("PERSONA");
    expect(withPersona.indexOf("PERSONA")).toBeLessThan(withPersona.indexOf("Task ID:"));
  });
});

function def(id: string, name: string): AgentDefinition {
  return { id, name, model: "claude-sonnet-4-6", prompt: `base-${id}`, appliedSkills: [], updatedAt: 0 };
}

describe("composeAgentPrompt", () => {
  it("prepends the task objective ahead of the base prompt", () => {
    const out = composeAgentPrompt(task, "BASE");
    expect(out).toContain("Add login");
    expect(out).toContain("Implement OAuth login");
    expect(out).toContain("BASE");
    expect(out.indexOf("Add login")).toBeLessThan(out.indexOf("BASE"));
  });

  it("omits a blank description", () => {
    const out = composeAgentPrompt({ title: "T", description: "   " }, "BASE");
    expect(out).toContain("T");
    expect(out).toContain("BASE");
    expect(out).not.toContain("\n\n\n");
  });
});

describe("planTaskDispatch", () => {
  let n = 0;
  const newId = () => `id-${++n}`;
  const ctx = () => ({ cwd: "/repo", origin: { x: 100, y: 200 }, newId, startAgentNumber: 0 });
  beforeEach(() => { n = 0; });

  it("single def: one agent node, no run deps, one task→agent triggers edge", () => {
    const plan = planTaskDispatch(task, [def("solo", "Solo")], "task-1", ctx());
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0].type).toBe("agent");
    expect(plan.agentIds).toEqual([plan.nodes[0].id]);
    expect(plan.rootIds).toEqual(plan.agentIds);
    expect(plan.deps).toEqual([]);
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0].source).toBe("task-1");
    expect(plan.edges[0].target).toBe(plan.agentIds[0]);
    expect((plan.edges[0].data as { wireKind?: string }).wireKind).toBe("triggers");
  });

  it("keeps each agent's prompt as its persona and seeds the task as initialTask (ADR-0022)", () => {
    const plan = planTaskDispatch(task, [def("solo", "Solo")], "task-1", ctx());
    const data = plan.nodes[0].data as { prompt: string; initialTask?: string };
    // Persona stays the agent's role; the task is no longer folded into the system prompt.
    expect(data.prompt).toBe("base-solo");
    expect(data.prompt).not.toContain("Add login");
    // The task brief is the auto-submitted initialTask the live persona runs once ready.
    expect(data.initialTask).toContain("Add login");
  });

  it("team: first def is the only root; orchestrates edges lead→each specialist", () => {
    const defs = [def("lead", "Lead"), def("be", "Backend"), def("fe", "Frontend")];
    const plan = planTaskDispatch(task, defs, "task-1", ctx());
    expect(plan.agentIds).toHaveLength(3);
    const leadId = plan.agentIds[0];
    expect(plan.rootIds).toEqual([leadId]);
    expect(plan.deps).toEqual([
      { from: leadId, to: plan.agentIds[1] },
      { from: leadId, to: plan.agentIds[2] },
    ]);
    // 3 task→agent (triggers) + 2 lead→specialist (orchestrates)
    expect(plan.edges).toHaveLength(5);
    const orchestrates = plan.edges.filter((e) => (e.data as { wireKind?: string }).wireKind === "orchestrates");
    expect(orchestrates).toHaveLength(2);
  });

  it("agent numbers increment from startAgentNumber", () => {
    const defs = [def("lead", "Lead"), def("be", "Backend")];
    const plan = planTaskDispatch(task, defs, "task-1", { ...ctx(), startAgentNumber: 5 });
    expect((plan.nodes[0].data as { agentNumber: number }).agentNumber).toBe(6);
    expect((plan.nodes[1].data as { agentNumber: number }).agentNumber).toBe(7);
  });

  it("stacks agents in a column to the right of the task origin", () => {
    const defs = [def("a", "A"), def("b", "B")];
    const plan = planTaskDispatch(task, defs, "task-1", ctx());
    expect(plan.nodes[0].position.x).toBe(plan.nodes[1].position.x);
    expect(plan.nodes[1].position.y).toBeGreaterThan(plan.nodes[0].position.y);
    expect(plan.nodes[0].position.x).toBeGreaterThan(100);
  });

  it("empty defs yield an empty plan", () => {
    const plan = planTaskDispatch(task, [], "task-1", ctx());
    expect(plan.nodes).toEqual([]);
    expect(plan.edges).toEqual([]);
    expect(plan.agentIds).toEqual([]);
    expect(plan.rootIds).toEqual([]);
    expect(plan.deps).toEqual([]);
  });
});

describe("planTeamLaunch (ADR-0027 Phase 6 launch-set)", () => {
  let n = 0;
  const newId = () => `id-${++n}`;
  const ctx = () => ({ cwd: "/repo", origin: { x: 100, y: 200 }, newId, startAgentNumber: 0 });
  beforeEach(() => { n = 0; });

  it("spawns N independent agents at once: all roots, no deps, no orchestrates edges", () => {
    const defs = [def("a", "A"), def("b", "B"), def("c", "C")];
    const plan = planTeamLaunch(defs, "team-1", ctx());
    expect(plan.nodes).toHaveLength(3);
    expect(plan.agentIds).toEqual(plan.nodes.map((node) => node.id));
    expect(plan.rootIds).toEqual(plan.agentIds); // all independent
    expect(plan.deps).toEqual([]);
    const triggers = plan.edges.filter((e) => (e.data as { wireKind?: string }).wireKind === "triggers");
    const orchestrates = plan.edges.filter((e) => (e.data as { wireKind?: string }).wireKind === "orchestrates");
    expect(triggers).toHaveLength(3);
    expect(orchestrates).toHaveLength(0);
    expect(plan.edges.every((e) => e.source === "team-1")).toBe(true);
  });

  it("launches bare: no auto-submitted task (initialTask) on any member", () => {
    const plan = planTeamLaunch([def("a", "A")], "team-1", ctx());
    expect((plan.nodes[0].data as { initialTask?: string }).initialTask).toBeUndefined();
  });
});
