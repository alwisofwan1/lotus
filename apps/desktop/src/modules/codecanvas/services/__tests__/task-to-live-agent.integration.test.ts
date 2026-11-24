import { describe, expect, it } from "vitest";
import { planTaskDispatch, type TaskObjective } from "../task-dispatch";
import { buildLiveAgentSpawnSpec } from "../live-agent-spawn";
import type { AgentDefinition, CanvasAgentNodeData } from "../../types/canvas";

/**
 * Integration: the Task -> live agent dispatch seam (everything bar the real PTY).
 *
 * Use-case: a user dispatches a concrete task ("add a safe divide() helper") to the Coder.
 * The flow must produce a LIVE persona whose IDENTITY (role) rides the system prompt and whose
 * TASK is auto-submitted once ready — never the old behaviour of folding the task into the prompt.
 */

const coder: AgentDefinition = {
  id: "agent-coder",
  name: "Coder",
  model: "claude-sonnet-4-6",
  role: "Full-stack implementer",
  prompt: "You are the Coder. Implement test-first and leave the repo green.",
  appliedSkills: ["tdd"],
  permissionMode: "full",
  runner: "claude",
  updatedAt: 0,
};

const task: TaskObjective = {
  title: "Add a safe divide(a, b) helper",
  intent: "Provide division that rejects a zero divisor instead of returning Infinity.",
  when: "this-week",
  acceptanceCriteria: [
    { id: "c1", text: "divide(6, 2) returns 3", done: false },
    { id: "c2", text: "divide(1, 0) throws a clear error", done: false },
  ],
};

function ctx() {
  let n = 0;
  return { cwd: "/repo", origin: { x: 0, y: 0 }, newId: () => `id-${++n}`, startAgentNumber: 0 };
}

/** Resolve the spawn spec exactly as LiveAgentNode does from the dispatched node's data. */
function specFromNode(data: CanvasAgentNodeData) {
  return buildLiveAgentSpawnSpec({
    runner: data.runner,
    model: data.model,
    permissionMode: data.permissionMode,
    rolePrompt: data.prompt,
    appliedSkills: data.appliedSkills,
    task: data.initialTask,
  });
}

describe("Task → live agent dispatch (integration)", () => {
  it("creates a live Coder persona seeded with the task as initialTask, not folded into the prompt", () => {
    const plan = planTaskDispatch(task, [coder], "task-1", ctx());

    expect(plan.nodes).toHaveLength(1);
    const data = plan.nodes[0].data as CanvasAgentNodeData;

    // Live persona by default (ADR-0022).
    expect(data.executionMode).toBe("live");
    // Prompt stays the agent's role — the task is NOT folded in.
    expect(data.prompt).toBe(coder.prompt);
    expect(data.prompt).not.toContain("divide");
    // The task brief is seeded as the auto-submittable initialTask.
    expect(data.initialTask).toContain("Add a safe divide(a, b) helper");
    expect(data.initialTask).toContain("divide(1, 0) throws a clear error");
    expect(data.initialTask).toContain("Timeline: this week");
  });

  it("spawns with the persona as the system prompt and the task as the auto-submitted message", () => {
    const plan = planTaskDispatch(task, [coder], "task-1", ctx());
    const spec = specFromNode(plan.nodes[0].data as CanvasAgentNodeData);

    // Persona + live contract ride --append-system-prompt; model is pinned so it doesn't drift.
    expect(spec.command).toContain("claude --dangerously-skip-permissions");
    expect(spec.command).toContain("--model claude-sonnet-4-6");
    expect(spec.command).toContain("--append-system-prompt");
    expect(spec.command).toContain("You are the Coder");
    expect(spec.command).toContain("live agent"); // LIVE operating contract injected
    expect(spec.command).toContain("tdd");          // applied skill in the persona

    // The task is the auto-submitted first message — NOT baked into the launch command.
    expect(spec.submitText).toContain("Add a safe divide(a, b) helper");
    expect(spec.command).not.toContain("Add a safe divide(a, b) helper");
  });

  it("carries the completion callback in the auto-submitted task when the Task is backend-backed", () => {
    const plan = planTaskDispatch({ ...task, taskId: "task-xyz-42", taskWorkspaceId: "ws-1" }, [coder], "task-1", ctx());
    const data = plan.nodes[0].data as CanvasAgentNodeData;
    expect(data.initialTask).toContain("task-xyz-42");
    expect(data.initialTask).toContain('PATCH "$AGENT_CANVAS_API/api/tasks/task-xyz-42?workspaceId=ws-1"');
    expect(data.initialTask).toContain('{"status":"in-review"}');
  });

  it("team dispatch seeds the same task into every member persona (lead + specialists)", () => {
    const reviewer: AgentDefinition = { ...coder, id: "agent-reviewer", name: "Reviewer", prompt: "You are the Reviewer." };
    const plan = planTaskDispatch(task, [coder, reviewer], "task-1", ctx());

    expect(plan.nodes).toHaveLength(2);
    expect(plan.rootIds).toEqual([plan.agentIds[0]]); // lead is the only root
    for (const node of plan.nodes) {
      const data = node.data as CanvasAgentNodeData;
      expect(data.executionMode).toBe("live");
      expect(data.initialTask).toContain("Add a safe divide(a, b) helper");
    }
  });
});
