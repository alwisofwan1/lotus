import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { injectCanvasNodeCallbacks } from "./canvas-flow-config";

const callbacks = {
  dispatchNodeCommand: vi.fn(),
  isSkillApplied: vi.fn(() => false),
  listAppliedSkills: vi.fn(() => []),
  hasBrowserNode: vi.fn(() => false),
};

describe("injectCanvasNodeCallbacks", () => {
  it("wires AgentNode command seam while preserving applied skills", () => {
    const nodes: Node[] = [{
      id: "agent-1",
      type: "agent",
      position: { x: 0, y: 0 },
      data: { appliedSkills: ["diagnose"] },
    }];

    const [agent] = injectCanvasNodeCallbacks(nodes, [], callbacks);

    expect(agent.data).toMatchObject({
      appliedSkills: ["diagnose"],
      dispatchCommand: callbacks.dispatchNodeCommand,
    });
  });

  it("injects active project id into AgentNode runtime data for project memory", () => {
    const nodes: Node[] = [{
      id: "agent-1",
      type: "agent",
      position: { x: 0, y: 0 },
      data: { name: "Rowan" },
    }];

    const [agent] = injectCanvasNodeCallbacks(nodes, [], { ...callbacks, activeProjectId: "cp_1" });

    expect(agent.data).toMatchObject({ projectId: "cp_1" });
  });

  it("injects the node command seam into command-migrated nodes", () => {
    const nodes: Node[] = [
      { id: "agent-1", type: "agent", position: { x: 0, y: 0 }, data: { name: "Agent" } },
      { id: "context-1", type: "context", position: { x: 0, y: 0 }, data: { title: "Context" } },
      { id: "critic-1", type: "critic", position: { x: 0, y: 0 }, data: { title: "Critic" } },
      { id: "gate-1", type: "human-gate", position: { x: 0, y: 0 }, data: { title: "Gate" } },
      { id: "note-1", type: "note", position: { x: 0, y: 0 }, data: { content: "Note" } },
      { id: "plan-1", type: "plan", position: { x: 0, y: 0 }, data: { title: "Plan" } },
      { id: "skill-1", type: "skill", position: { x: 0, y: 0 }, data: { skillName: "ship" } },
      { id: "skills-1", type: "skills", position: { x: 0, y: 0 }, data: { parentTerminalId: "term-1" } },
      { id: "task-1", type: "task", position: { x: 0, y: 0 }, data: { title: "Task" } },
      { id: "team-1", type: "team", position: { x: 0, y: 0 }, data: { name: "Team" } },
    ];

    const [agent, context, critic, gate, note, plan, skill, skills, task, team] = injectCanvasNodeCallbacks(nodes, [], callbacks);

    for (const node of [agent, context, critic, gate, note, plan, skill, skills, task, team]) {
      expect(node.data).toMatchObject({ dispatchCommand: callbacks.dispatchNodeCommand });
    }
    expect(task.data?.onChange).toBeUndefined();
    expect(task.data?.onDispatch).toBeUndefined();
  });

  it("injects the parent terminal runtime pane id into paired browser nodes", () => {
    const nodes: Node[] = [
      {
        id: "term-1",
        type: "terminal",
        position: { x: 0, y: 0 },
        data: { runtimePaneId: "canvas:project:term-1" },
      },
      {
        id: "browser-1",
        type: "browser",
        position: { x: 400, y: 0 },
        data: { parentTerminalId: "term-1" },
      },
    ];

    const [, browser] = injectCanvasNodeCallbacks(nodes, [], callbacks);

    expect(browser.data).toMatchObject({
      parentTerminalId: "term-1",
      parentRuntimePaneId: "canvas:project:term-1",
      dispatchCommand: callbacks.dispatchNodeCommand,
    });
  });

  it("recovers a paired browser parent from the terminal-to-browser edge when node data is stale", () => {
    const nodes: Node[] = [
      {
        id: "term-1",
        type: "terminal",
        position: { x: 0, y: 0 },
        data: { runtimePaneId: "canvas:project:term-1" },
      },
      {
        id: "browser-1",
        type: "browser",
        position: { x: 400, y: 0 },
        data: { parentTerminalId: null },
      },
    ];

    const [, browser] = injectCanvasNodeCallbacks(nodes, [{ id: "edge-1", source: "term-1", target: "browser-1" }], callbacks);

    expect(browser.data).toMatchObject({
      parentTerminalId: "term-1",
      parentRuntimePaneId: "canvas:project:term-1",
      dispatchCommand: callbacks.dispatchNodeCommand,
    });
  });
});

describe("injectCanvasNodeCallbacks — Skills node runner", () => {
  function skillsNodeWith(parent: Node | null) {
    const nodes: Node[] = [
      ...(parent ? [parent] : []),
      { id: "skills-1", type: "skills", position: { x: 0, y: 0 }, data: { parentTerminalId: "agent-1" } },
    ];
    return injectCanvasNodeCallbacks(nodes, [], callbacks).find((n) => n.id === "skills-1")!;
  }

  it("hands the Skills node its parent agent's runner, so the list prints the right token", () => {
    const parent: Node = { id: "agent-1", type: "agent", position: { x: 0, y: 0 }, data: { runner: "codex" } };

    expect(skillsNodeWith(parent).data).toMatchObject({ parentRunner: "codex" });
  });

  it("passes the claudeFamily override through for a custom runner", () => {
    const parent: Node = {
      id: "agent-1", type: "agent", position: { x: 0, y: 0 },
      data: { runner: "custom", claudeFamily: true },
    };

    expect(skillsNodeWith(parent).data).toMatchObject({ parentRunner: "custom", parentClaudeFamily: true });
  });

  it("leaves the runner undefined when the parent is gone — the node falls back to Claude", () => {
    expect(skillsNodeWith(null).data.parentRunner).toBeUndefined();
  });
});
