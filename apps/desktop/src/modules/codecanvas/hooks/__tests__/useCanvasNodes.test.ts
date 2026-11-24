import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  closeTerminalSession: vi.fn(),
}));

import { useCanvasNodes } from "../useCanvasNodes";
import { createPersistentPty, hasPersistentPty, clearPersistentPtyPoolForTests } from "@/lib/pty-session-pool";
import type { PtySessionController } from "@/lib/pty-session-controller";
import { registerHeadlessAgentStop } from "../../services/headless-agent-sessions";
import { agentIdentityRegistry } from "../../services/agent-identity-registry";
import type { AgentDefinition, CanvasSnapshot } from "../../types/canvas";

const SNAPSHOT: CanvasSnapshot = {
  schemaVersion: 1,
  id: "default",
  rootDir: "/projects/app",
  nodes: [
    {
      type: "terminal",
      id: "term-1",
      position: { x: 0, y: 0 },
      size: { w: 560, h: 360 },
      cwd: "/projects/app",
      terminalNumber: 1,
      assignedWorktree: null,
    },
    {
      type: "note",
      id: "note-1",
      position: { x: 100, y: 100 },
      size: { w: 300, h: 200 },
      content: "Ship checklist",
    },
  ],
  edges: [],
};

function rect(node: { position: { x: number; y: number }; width?: number | null; height?: number | null }) {
  return {
    x: node.position.x,
    y: node.position.y,
    w: node.width ?? 0,
    h: node.height ?? 0,
  };
}

function overlaps(a: ReturnType<typeof rect>, b: ReturnType<typeof rect>, padding = 16) {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  );
}

describe("useCanvasNodes", () => {
  it("ReactFlow deletion retains the connections of an agent whose stop fails", async () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn(), { current: "delete-edges" }));
    let id!: string;
    act(() => { id = result.current.addAgentNode({ id: "def", name: "Job", model: "", prompt: "", appliedSkills: [], updatedAt: 0 })!; });
    const node = result.current.nodes.find((n) => n.id === id)!;
    const edge = { id: "wire", source: id, target: "note" };
    act(() => result.current.onEdgesChange([{ type: "add", item: edge }]));
    const unregister = registerHeadlessAgentStop(`canvas:delete-edges:${id}`, async () => { throw new Error("failed"); });
    let deletion!: { nodes: unknown[]; edges: unknown[] } | boolean;
    await act(async () => { deletion = await result.current.onBeforeDelete({ nodes: [node], edges: [edge] }); });
    expect(deletion).toEqual({ nodes: [], edges: [] });
    expect(result.current.edges.map((e) => e.id)).toContain("wire");
    unregister();
  });
  it("delete Frame with contents retains its failed agent and Frame", async () => {
    const project = { current: "frame-close" };
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn(), project));
    let id!: string;
    act(() => { id = result.current.addAgentNode({ id: "def", name: "Job", model: "", prompt: "", appliedSkills: [], updatedAt: 0 } as AgentDefinition)!; });
    const frameId = result.current.nodes.find((node) => node.type === "frame")!.id;
    const unregister = registerHeadlessAgentStop(`canvas:frame-close:${id}`, async () => { throw new Error("failed"); });
    await act(async () => { await result.current.deleteFrameAndContents(frameId); });
    expect(result.current.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([id, frameId]));
    unregister();
  });
  it("close all waits for headless stop and keeps a failed agent available for retry", async () => {
    const project = { current: "headless-close" };
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn(), project));
    let id!: string;
    act(() => { id = result.current.addAgentNode({ id: "def", name: "Job", model: "", prompt: "", appliedSkills: [], updatedAt: 0 } as AgentDefinition)!; });
    const stop = vi.fn().mockRejectedValueOnce(new Error("stop failed")).mockResolvedValue(undefined);
    const unregister = registerHeadlessAgentStop(`canvas:headless-close:${id}`, stop);
    await act(async () => { await result.current.removeAllNodes(); });
    expect(result.current.nodes.map((node) => node.id)).toContain(id);
    expect(result.current.closeError).toBeTruthy();
    await act(async () => { await result.current.removeNode(id); });
    expect(result.current.nodes.map((node) => node.id)).not.toContain(id);
    expect(stop).toHaveBeenCalledTimes(2);
    unregister();
  });
  it("Delete keeps an agent node until its PTY kill succeeds and allows retry", async () => {
    const project = { current: "close-test" };
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn(), project));
    let id!: string;
    act(() => { id = result.current.addAgentNode({ id: "def", name: "Close", model: "", prompt: "", appliedSkills: [], updatedAt: 0 } as AgentDefinition)!; });
    const key = `canvas:close-test:${id}`;
    agentIdentityRegistry.record(key, { name: "Close", nodeId: id });
    let acknowledge!: () => void;
    const abortConfirmed = vi.fn().mockRejectedValueOnce(new Error("native unavailable"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    createPersistentPty(key, "canvas:close-test", { abortConfirmed, abort: vi.fn() } as unknown as PtySessionController);
    await act(async () => { result.current.onNodesChange([{ type: "remove", id }]); });
    expect(result.current.nodes.some((node) => node.id === id)).toBe(true);
    expect(hasPersistentPty(key)).toBe(true);
    expect(agentIdentityRegistry.get(key)?.name).toBe("Close");
    let close!: Promise<unknown>;
    act(() => { close = result.current.removeNode(id) as unknown as Promise<unknown>; });
    expect(result.current.nodes.some((node) => node.id === id)).toBe(true);
    await act(async () => { acknowledge(); await close; });
    expect(result.current.nodes.some((node) => node.id === id)).toBe(false);
    expect(hasPersistentPty(key)).toBe(false);
    expect(agentIdentityRegistry.get(key)).toBeUndefined();
    clearPersistentPtyPoolForTests();
  });
  it("dedupes agent handles across a same-tick batch spawn (no duplicate names)", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    // Same definition (same baked name) spawned three times in one tick — e.g. "spawn 3 cursor agents".
    const def = { id: "def-cursor", name: "Rowan", model: "", prompt: "", runner: "cursor", appliedSkills: [] } as unknown as AgentDefinition;
    act(() => {
      result.current.addAgentNode(def);
      result.current.addAgentNode(def);
      result.current.addAgentNode(def);
    });
    const names = result.current.nodes
      .filter((n) => n.type === "agent")
      .map((n) => (n.data as { name: string }).name);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3); // all distinct → dispatch-by-name stays unambiguous
    expect(names[0]).toBe("Rowan"); // first keeps the desired handle
  });

  // Slice 03: the name pool is now shuffled per draw. If that draw happened INSIDE
  // `setNodes`'s updater instead of before it, StrictMode's double-invoked updater would
  // draw two different shuffled orders for the same spawn and could land on two different
  // names. One spawn call must still produce exactly one node with one name.
  it("(slice 03) adds exactly one named agent node per call under StrictMode's double-invoked updater", () => {
    const { result } = renderHook(
      () => useCanvasNodes({ current: "/projects/app" }, vi.fn()),
      { wrapper: StrictMode },
    );
    const def = { id: "def-strict", name: "", model: "", prompt: "", runner: "claude", appliedSkills: [] } as unknown as AgentDefinition;

    act(() => {
      result.current.addAgentNode(def);
    });

    const agentNodes = result.current.nodes.filter((n) => n.type === "agent");
    expect(agentNodes).toHaveLength(1);
    expect((agentNodes[0].data as { name?: string }).name).toBeTruthy();
  });


  it("staggers the mount animation across a same-burst batch spawn", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    const def = { id: "def-a", name: "Rowan", model: "", prompt: "", appliedSkills: [] } as unknown as AgentDefinition;
    act(() => {
      result.current.addAgentNode(def);
      result.current.addAgentNode(def);
      result.current.addAgentNode(def);
    });
    // The first agent also creates "Frame 1" around itself (decision 37); the Frame is not part of the burst.
    const delays = result.current.nodes.filter((n) => n.type !== "frame").map(
      (n) => (n.style as Record<string, string> | undefined)?.["--canvas-enter-delay"],
    );
    // First node of the burst mounts immediately; followers cascade in.
    expect(delays[0]).toBeUndefined();
    expect(delays[1]).toBe("64ms");
    expect(delays[2]).toBe("128ms");
  });

  it("markAllNodesLeaving tags every node with a cascading leave delay and reports the total", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    act(() => {
      result.current.addTerminalNode();
      result.current.addNoteNode();
    });
    let total = 0;
    act(() => { total = result.current.markAllNodesLeaving(); });

    for (const node of result.current.nodes) {
      expect(node.className).toContain("canvas-node-leaving");
    }
    const delays = result.current.nodes.map(
      (n) => (n.style as Record<string, string>)["--canvas-leave-delay"],
    );
    // Three nodes now: "Frame 1" (created around the first window), the terminal and the note.
    expect(result.current.nodes).toHaveLength(3);
    expect(delays[0]).toBe("0ms");
    expect(delays[1]).toBe("42ms");
    // Last node starts at 84ms and plays the delayed close envelope.
    expect(total).toBe(384);
  });

  it("markAllNodesLeaving on an empty canvas is a no-op that reports zero", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    let total = -1;
    act(() => { total = result.current.markAllNodesLeaving(); });
    expect(total).toBe(0);
  });

  it("numbers legacy notes on load and gives new notes the next number", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    act(() => result.current.loadSnapshot({
      ...SNAPSHOT,
      nodes: [
        ...SNAPSHOT.nodes,
        { type: "note", id: "note-2", position: { x: 160, y: 160 }, size: { w: 300, h: 200 }, content: "Second" },
      ],
    }));

    expect(result.current.nodes.find((node) => node.id === "note-1")?.data).toMatchObject({ noteNumber: 1 });
    expect(result.current.nodes.find((node) => node.id === "note-2")?.data).toMatchObject({ noteNumber: 2 });

    act(() => result.current.addNoteNode());

    const created = result.current.nodes.filter((node) => node.type === "note").at(-1)!;
    expect(created.data).toMatchObject({ noteNumber: 3 });
    expect(created).toMatchObject({ draggable: true, dragHandle: ".canvas-node-header, .canvas-node-glyph" });
  });

  it("tags hydrated nodes as restored so project opens do not replay node-enter choreography", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));

    act(() => result.current.loadSnapshot(SNAPSHOT));

    expect(result.current.nodes.every((node) => node.className?.split(" ").includes("canvas-node-restored"))).toBe(true);
  });

  it("does not treat sidebar click events as note spawn coordinates", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    act(() => result.current.loadSnapshot(SNAPSHOT));

    const clickEventLike = {
      x: 14,
      y: 28,
      preventDefault: vi.fn(),
      currentTarget: document.createElement("button"),
    };
    act(() => result.current.addNoteNode(clickEventLike as unknown as { x: number; y: number }));

    const created = result.current.nodes.filter((node) => node.type === "note").at(-1)!;
    expect(created.position).not.toBe(clickEventLike);
    // A new window joins the active Frame in a free slot (decision 38) rather than at the drop point.
    expect(created.position).not.toEqual({ x: 14, y: 28 });
    expect((created.data as { frameId?: string }).frameId).toBeTruthy();
  });

  it("selects only the focused node without autosaving transient selection", () => {
    const scheduleAutosave = vi.fn();
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, scheduleAutosave));

    act(() => result.current.loadSnapshot(SNAPSHOT));
    act(() => result.current.focusNode("note-1"));

    expect(result.current.nodes.find((node) => node.id === "note-1")?.selected).toBe(true);
    expect(result.current.nodes.find((node) => node.id === "term-1")?.selected).toBe(false);
    expect(scheduleAutosave).not.toHaveBeenCalled();
  });

  it("addSkillsNode spawns a Skills node wired dashed from the terminal, deduped per terminal", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    act(() => result.current.loadSnapshot(SNAPSHOT));
    let returnedId: string | undefined;
    act(() => { returnedId = result.current.addSkillsNode("term-1", "/projects/app"); });

    let skillsNodes = result.current.nodes.filter((n) => n.type === "skills");
    expect(returnedId).toBe(skillsNodes[0].id);
    expect(skillsNodes).toHaveLength(1);
    expect(skillsNodes[0].data).toMatchObject({ parentTerminalId: "term-1", cwd: "/projects/app" });
    const edge = result.current.edges.find((e) => e.source === "term-1" && e.target === skillsNodes[0].id);
    expect(edge).toMatchObject({
      animated: true,
      type: "canvas-wire",
      className: "canvas-wire canvas-wire--skills",
      interactionWidth: 24,
      data: { wireKind: "skills" },
    });

    act(() => { returnedId = result.current.addSkillsNode("term-1", "/projects/app"); });
    skillsNodes = result.current.nodes.filter((n) => n.type === "skills");
    expect(skillsNodes).toHaveLength(1);
    expect(returnedId).toBe(skillsNodes[0].id);
    expect(skillsNodes[0].selected).toBe(true);
  });

  it("places the Skills node close to the terminal edge instead of sending it across the canvas", () => {
    const snapshot: CanvasSnapshot = {
      ...SNAPSHOT,
      nodes: [{
        type: "terminal",
        id: "term-1",
        position: { x: 10, y: 20 },
        size: { w: 900, h: 360 },
        cwd: "/projects/app",
        terminalNumber: 1,
        assignedWorktree: null,
      }],
    };
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));

    act(() => result.current.loadSnapshot(snapshot));
    act(() => result.current.addSkillsNode("term-1", "/projects/app"));

    const skillsNode = result.current.nodes.find((n) => n.type === "skills")!;
    expect(skillsNode.position).toEqual({ x: 934, y: 20 });
  });

  it("places a new Skills node in the nearest empty slot when another node blocks the default spot", () => {
    const snapshot: CanvasSnapshot = {
      ...SNAPSHOT,
      nodes: [
        {
          type: "terminal",
          id: "term-1",
          position: { x: 0, y: 0 },
          size: { w: 560, h: 360 },
          cwd: "/projects/app",
          terminalNumber: 1,
          assignedWorktree: null,
        },
        {
          type: "note",
          id: "blocker",
          position: { x: 584, y: 0 },
          size: { w: 320, h: 460 },
          content: "Block the default Skills slot",
        },
      ],
    };
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));

    act(() => result.current.loadSnapshot(snapshot));
    act(() => result.current.addSkillsNode("term-1", "/projects/app"));

    const skillsNode = result.current.nodes.find((n) => n.type === "skills")!;
    const terminal = result.current.nodes.find((n) => n.id === "term-1")!;
    const blocker = result.current.nodes.find((n) => n.id === "blocker")!;
    expect(skillsNode.position).not.toEqual({ x: 584, y: 0 });
    expect(overlaps(rect(skillsNode), rect(terminal))).toBe(false);
    expect(overlaps(rect(skillsNode), rect(blocker))).toBe(false);
    expect(skillsNode.position.x).toBeLessThan(1000);
  });

  it("addSkillNode creates a skill preview wired dashed from its parent (parent → preview)", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    act(() => result.current.loadSnapshot(SNAPSHOT));
    let returnedId: string | undefined;
    act(() => { returnedId = result.current.addSkillNode({ name: "ship", source: "project", content: "# Ship" }, "skills-1"); });

    const skillNodes = result.current.nodes.filter((n) => n.type === "skill");
    expect(returnedId).toBe(skillNodes[0].id);
    expect(skillNodes).toHaveLength(1);
    expect(skillNodes[0].data).toMatchObject({ skillName: "ship", source: "project", content: "# Ship" });

    const edge = result.current.edges.find((e) => e.source === "skills-1" && e.target === skillNodes[0].id);
    expect(edge).toMatchObject({
      animated: true,
      type: "canvas-wire",
      className: "canvas-wire canvas-wire--skill-preview",
      interactionWidth: 24,
      data: { wireKind: "skill-preview" },
    });
  });

  it("updates wire kind, ports, reconnect target, and deletion through edge management actions", () => {
    const scheduleAutosave = vi.fn();
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, scheduleAutosave));
    act(() => result.current.loadSnapshot({
      ...SNAPSHOT,
      edges: [{ id: "edge-1", source: "term-1", target: "note-1" }],
    }));

    act(() => result.current.setEdgeKind("edge-1", "triggers"));
    expect(result.current.edges[0]).toMatchObject({
      id: "edge-1",
      animated: true,
      label: "triggers",
      data: { wireKind: "triggers" },
    });

    act(() => result.current.setEdgeHandle("edge-1", "source", "wire-bottom"));
    act(() => result.current.setEdgeHandle("edge-1", "target", "wire-top"));
    expect(result.current.edges[0]).toMatchObject({ sourceHandle: "wire-bottom", targetHandle: "wire-top" });

    act(() => result.current.onReconnect(result.current.edges[0], {
      source: "note-1",
      target: "term-1",
      sourceHandle: "wire-left",
      targetHandle: "wire-right",
    }));
    expect(result.current.edges[0]).toMatchObject({
      source: "note-1",
      target: "term-1",
      sourceHandle: "wire-left",
      targetHandle: "wire-right",
      data: { wireKind: "default" },
    });

    act(() => result.current.removeEdge("edge-1"));
    expect(result.current.edges).toEqual([]);
    expect(scheduleAutosave).toHaveBeenCalled();
  });

  it("restores the dash-flow animation for non-default wires, leaving plain wires static", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    act(() => result.current.loadSnapshot({
      ...SNAPSHOT,
      edges: [
        { id: "edge-trig", source: "term-1", target: "note-1", kind: "triggers" },
        { id: "edge-plain", source: "note-1", target: "term-1" },
      ],
    }));

    expect(result.current.edges.find((e) => e.id === "edge-trig")).toMatchObject({ animated: true });
    expect(result.current.edges.find((e) => e.id === "edge-plain")).toMatchObject({ animated: false });
  });

  it("keeps non-agent plain wires out of the semantic cycle", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    act(() => result.current.loadSnapshot({
      ...SNAPSHOT,
      edges: [{ id: "edge-1", source: "term-1", target: "note-1" }],
    }));

    act(() => result.current.cycleEdgeSemantic("edge-1"));

    expect(result.current.edges[0]).toMatchObject({ data: { wireKind: "default" } });
    expect(result.current.edges[0].label).toBeUndefined();
  });

  it("opening another skill replaces the existing preview's content in place (no second node)", () => {
    const { result } = renderHook(() => useCanvasNodes({ current: "/projects/app" }, vi.fn()));
    act(() => result.current.loadSnapshot(SNAPSHOT));
    act(() => result.current.addSkillNode({ name: "ship", source: "project", content: "# Ship" }, "skills-1"));
    const firstId = result.current.nodes.find((n) => n.type === "skill")!.id;

    let returnedId: string | undefined;
    act(() => { returnedId = result.current.addSkillNode({ name: "diagnose", source: "global", content: "# Diagnose" }, "skills-1"); });

    const skillNodes = result.current.nodes.filter((n) => n.type === "skill");
    expect(skillNodes).toHaveLength(1);
    expect(skillNodes[0].id).toBe(firstId);
    expect(returnedId).toBe(firstId);
    expect(skillNodes[0].data).toMatchObject({ skillName: "diagnose", source: "global", content: "# Diagnose" });
    expect(skillNodes[0].selected).toBe(true);
    // No duplicate edge created.
    expect(result.current.edges.filter((e) => e.source === "skills-1" && e.target === firstId)).toHaveLength(1);
  });
});
