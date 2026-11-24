import { describe, it, expect } from "vitest";
import { createAgentNode, agentRecordToNode, DEFAULT_AGENT_SIZE } from "../canvas-agent-node";
import type { AgentDefinition, CanvasAgentNodeRecord } from "../../types/canvas";

const def: AgentDefinition = {
  id: "def-1", name: "Frontend Specialist", model: "claude-sonnet-4-6",
  prompt: "build the UI", appliedSkills: [], updatedAt: 0,
};

describe("canvas agent node factory", () => {
  it("creates a ReactFlow agent node from a definition with cached config", () => {
    const node = createAgentNode(def, { id: "n1", cwd: "/repo", agentNumber: 3, position: { x: 10, y: 20 } });
    expect(node).toMatchObject({
      id: "n1", type: "agent", position: { x: 10, y: 20 },
      width: DEFAULT_AGENT_SIZE.w, height: DEFAULT_AGENT_SIZE.h,
      data: { agentDefId: "def-1", name: "Frontend Specialist", model: "claude-sonnet-4-6", prompt: "build the UI", cwd: "/repo", agentNumber: 3 },
    });
  });

  it("defaults a newly created agent node to the live execution mode (ADR-0022)", () => {
    const node = createAgentNode(def, { id: "n1", cwd: "/repo", agentNumber: 1, position: { x: 0, y: 0 } });
    expect(node.data).toMatchObject({ executionMode: "live" });
  });

  it("caches a custom runner's command onto the node so the kernel can spawn it (regression)", () => {
    const custom: AgentDefinition = { ...def, runner: "custom", runnerCommand: "ccs wesley --dangerously-skip-permissions" };
    const node = createAgentNode(custom, { id: "n1", cwd: "/repo", agentNumber: 1, position: { x: 0, y: 0 } });
    expect(node.data).toMatchObject({ runner: "custom", runnerCommand: "ccs wesley --dangerously-skip-permissions" });
    // And it survives a record round-trip (reopened custom agent still spawns).
    const rec: CanvasAgentNodeRecord = {
      type: "agent", id: "n1", position: { x: 0, y: 0 }, size: { w: 300, h: 240 },
      cwd: "/repo", agentNumber: 1, agentDefId: "def-1", name: "Wesley", model: "", prompt: "",
      runner: "custom", runnerCommand: "ccs wesley --dangerously-skip-permissions",
    };
    expect(agentRecordToNode(rec, "/repo", { x: 0, y: 0 }).data).toMatchObject({
      runner: "custom",
      runnerCommand: "ccs wesley --dangerously-skip-permissions",
    });
  });

  it("restores execution mode from the record, defaulting old snapshots to headless (back-compat)", () => {
    const base: CanvasAgentNodeRecord = {
      type: "agent", id: "n2", position: { x: 0, y: 0 }, size: { w: 300, h: 240 },
      cwd: "/repo", agentNumber: 1, agentDefId: "def-1", name: "Agent", model: "m", prompt: "p",
    };
    // Pre-ADR snapshot has no executionMode → must stay headless so old boards don't change behaviour.
    expect(agentRecordToNode(base, "/root", { x: 0, y: 0 }).data).toMatchObject({ executionMode: "headless" });
    // A persisted live agent round-trips back to live.
    expect(agentRecordToNode({ ...base, executionMode: "live" }, "/root", { x: 0, y: 0 }).data).toMatchObject({ executionMode: "live" });
  });

  it("caches the definition's runner onto the node for live spawn via the Agent Runtime Kernel (ADR-0023)", () => {
    const node = createAgentNode({ ...def, runner: "codex" }, { id: "n1", cwd: "/repo", agentNumber: 1, position: { x: 0, y: 0 } });
    expect(node.data).toMatchObject({ runner: "codex" });
  });

  it("caches the definition's persona colour onto the node (Slice 6)", () => {
    const node = createAgentNode({ ...def, color: "#e879a6" }, { id: "n1", cwd: "/repo", agentNumber: 1, position: { x: 0, y: 0 } });
    expect(node.data).toMatchObject({ color: "#e879a6" });
  });

  it("seeds an initialTask (auto-submitted by a live persona once ready) when dispatched with one", () => {
    const node = createAgentNode(def, { id: "n1", cwd: "/repo", agentNumber: 1, position: { x: 0, y: 0 }, initialTask: "Implement add(a,b)" });
    expect(node.data).toMatchObject({ initialTask: "Implement add(a,b)" });
  });

  it("omits initialTask for a plain agent (bare spawn → persona sits ready, idle)", () => {
    const node = createAgentNode(def, { id: "n1", cwd: "/repo", agentNumber: 1, position: { x: 0, y: 0 } });
    expect((node.data as Record<string, unknown>).initialTask).toBeUndefined();
  });

  it("restores the runner from the record", () => {
    const base: CanvasAgentNodeRecord = {
      type: "agent", id: "n2", position: { x: 0, y: 0 }, size: { w: 300, h: 240 },
      cwd: "/repo", agentNumber: 1, agentDefId: "def-1", name: "Agent", model: "m", prompt: "p",
    };
    expect(agentRecordToNode({ ...base, runner: "codex" }, "/root", { x: 0, y: 0 }).data).toMatchObject({ runner: "codex" });
    expect(agentRecordToNode({ ...base, color: "#38bdf8" }, "/root", { x: 0, y: 0 }).data).toMatchObject({ color: "#38bdf8" });
  });

  it("rebuilds a node from a persisted record, falling back cwd to rootDir", () => {
    const rec: CanvasAgentNodeRecord = {
      type: "agent", id: "n2", position: { x: 0, y: 0 }, size: { w: 300, h: 240 },
      cwd: "", agentNumber: 1, agentDefId: "def-1", name: "Agent", model: "m", prompt: "p",
    };
    const node = agentRecordToNode(rec, "/root", { x: 5, y: 5 });
    expect(node).toMatchObject({
      id: "n2", type: "agent", position: { x: 5, y: 5 }, width: 300, height: 240,
      data: { cwd: "/root", prompt: "p", agentDefId: "def-1" },
    });
  });

  it("restores the assigned worktree, path, and base branch from the record (ADR 0015)", () => {
    const rec: CanvasAgentNodeRecord = {
      type: "agent", id: "n3", position: { x: 0, y: 0 }, size: { w: 300, h: 240 },
      cwd: "/repo", agentNumber: 1, agentDefId: "def-1", name: "Agent", model: "m", prompt: "p",
      assignedWorktree: "lotus/team/frontend",
      assignedWorktreePath: "/repo/../.lotus-worktrees/team/frontend",
      baseBranch: "main",
    };
    const node = agentRecordToNode(rec, "/root", { x: 0, y: 0 });
    expect(node.data).toMatchObject({
      assignedWorktree: "lotus/team/frontend",
      assignedWorktreePath: "/repo/../.lotus-worktrees/team/frontend",
      baseBranch: "main",
    });
  });

  it("restores resumeSessionId from the record, nulling it when absent (ADR-0027 Phase 5)", () => {
    const base: CanvasAgentNodeRecord = {
      type: "agent", id: "n4", position: { x: 0, y: 0 }, size: { w: 300, h: 240 },
      cwd: "/repo", agentNumber: 1, agentDefId: "def-1", name: "Agent", model: "m", prompt: "p",
    };
    expect(agentRecordToNode({ ...base, resumeSessionId: "sess-77" }, "/root", { x: 0, y: 0 }).data).toMatchObject({
      resumeSessionId: "sess-77",
    });
    expect(agentRecordToNode(base, "/root", { x: 0, y: 0 }).data).toMatchObject({ resumeSessionId: null });
  });
});
