import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as canvasBrowserApi from "@/lib/tauri/canvas-browser";
import { useCanvasCommandCenter, type CanvasCommandCenterOptions } from "./useCanvasCommandCenter";
import { resetCanvasBehaviorStoreForTests, setCanvasBehaviorSetting } from "../hooks/useCanvasBehaviorSettings";
import type { AgentDefinition, CanvasSkillPreview, SmartConvertDraft } from "../types/canvas";

vi.mock("@/lib/tauri/canvas-browser", () => ({
  navigateCanvasBrowser: vi.fn().mockResolvedValue(undefined),
}));

function makeOptions(overrides: Partial<CanvasCommandCenterOptions> = {}): CanvasCommandCenterOptions {
  return {
    addTerminalNode: vi.fn(() => "terminal-1"),
    addNoteNode: vi.fn(() => "note-1"),
    addPlanNode: vi.fn(() => "plan-1"),
    addTaskNode: vi.fn(() => "task-1"),
    addContextNode: vi.fn(() => "context-1"),
    addCriticNode: vi.fn(() => "critic-1"),
    addHumanGateNode: vi.fn(() => "gate-1"),
    addTeamNode: vi.fn(() => "team-1"),
    addMusicNode: vi.fn(() => "music-1"),
    addRunNode: vi.fn((ids: string[]) => (ids.length > 0 ? "run-1" : null)),
    nodes: [],
    edges: [],
    flowInstance: null,
    addAgentNode: vi.fn(() => "agent-1"),
    addSkillsNode: vi.fn(() => "skills-1"),
    addSkillNode: vi.fn(() => "skill-1"),
    spawnBrowserNode: vi.fn(() => "browser-1"),
    spawnStandaloneBrowserNode: vi.fn(() => "browser-1"),
    closeBrowserNode: vi.fn(),
    removeNode: vi.fn(),
    markNodeLeaving: vi.fn(),
    markAllNodesLeaving: vi.fn(() => 0),
    removeAllNodes: vi.fn(),
    patchNodeData: vi.fn(),
    focusNode: vi.fn(),
    focusNodes: vi.fn(),
    dispatchTask: vi.fn(),
    convertNoteToTask: vi.fn(),
    arrangeNodes: vi.fn(),
    commitAgentDraw: vi.fn(),
    ...overrides,
  };
}

const agentDef: AgentDefinition = {
  id: "agent-def-1",
  name: "Builder",
  model: "claude-sonnet-4-6",
  prompt: "Build",
  appliedSkills: [],
  updatedAt: 1,
};

const skillPreview: CanvasSkillPreview = {
  name: "ship",
  source: "global",
  content: "Ship",
  description: "Ship",
  path: "/skills/ship.md",
};

describe("useCanvasCommandCenter", () => {
  // These tests assert per-node focus; disable auto-tidy so focus isn't suppressed by it.
  beforeEach(() => {
    vi.clearAllMocks();
    resetCanvasBehaviorStoreForTests();
    setCanvasBehaviorSetting("tidyMode", "off");
  });

  it("suppresses auto-focus on create when an auto-tidy will reframe the canvas", () => {
    setCanvasBehaviorSetting("tidyMode", "open");
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));
    result.current({ kind: "create-node", nodeType: "terminal" });
    expect(options.focusNode).not.toHaveBeenCalled();
  });

  it("draws a diagram directly via commitAgentDraw (no node spawn) from a draw-diagram command", () => {
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({
      kind: "draw-diagram",
      topic: "login flow",
      graph: { nodes: [{ id: "a", label: "Start" }, { id: "b", label: "Login" }], edges: [{ from: "a", to: "b" }] },
    });

    expect(options.commitAgentDraw).toHaveBeenCalledTimes(1);
    const application = (options.commitAgentDraw as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { nodes: unknown[]; edges: unknown[] };
    expect(application.nodes.length).toBeGreaterThanOrEqual(3); // 2 shapes + frame
    expect(application.edges.length).toBe(1);
    // Never spawns an agent for a direct draw.
    expect(options.addAgentNode).not.toHaveBeenCalled();
  });

  it("surfaces an error (does not silently drop) for a draw-diagram command with an empty graph", () => {
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));
    const out = result.current({ kind: "draw-diagram", topic: "x", graph: { nodes: [], edges: [] } });
    expect(options.commitAgentDraw).not.toHaveBeenCalled();
    expect(out.error).toBeTruthy();
  });

  it("replaces an existing diagram in place when the new graph reuses a majority of its node ids (edit)", () => {
    // An existing diagram D1 with 2 members (login, valid) + frame.
    const existing = [
      { id: "f1", type: "shape", position: { x: 0, y: 0 }, width: 300, height: 300, data: { shape: "rectangle", diagramFrame: true, diagramId: "D1", areaLabel: "Login" } },
      { id: "s1", type: "shape", position: { x: 20, y: 20 }, width: 160, height: 60, data: { shape: "rectangle", diagramId: "D1", diagramNodeId: "login", text: "Login" } },
      { id: "s2", type: "shape", position: { x: 20, y: 120 }, width: 160, height: 60, data: { shape: "rectangle", diagramId: "D1", diagramNodeId: "valid", text: "Valid?" } },
    ] as unknown as CanvasCommandCenterOptions["nodes"];
    const options = makeOptions({ nodes: existing });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({
      kind: "draw-diagram", topic: "Login",
      graph: { nodes: [{ id: "login", label: "Login" }, { id: "valid", label: "Valid?" }, { id: "verify", label: "Verify email" }], edges: [{ from: "login", to: "valid" }, { from: "valid", to: "verify" }] },
    });

    expect(options.commitAgentDraw).toHaveBeenCalledTimes(1);
    const application = (options.commitAgentDraw as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { removeIds: string[]; draft: boolean };
    // The old diagram's nodes (frame + members) are removed in the same commit → replace, not duplicate.
    expect(application.removeIds).toEqual(expect.arrayContaining(["f1", "s1", "s2"]));
    expect(application.draft).toBe(true); // a replace is forced-draft so it's revertible
  });

  it("does NOT remove anything for a brand-new diagram (no id overlap)", () => {
    const existing = [
      { id: "s1", type: "shape", position: { x: 20, y: 20 }, width: 160, height: 60, data: { shape: "rectangle", diagramId: "D1", diagramNodeId: "login", text: "Login" } },
    ] as unknown as CanvasCommandCenterOptions["nodes"];
    const options = makeOptions({ nodes: existing });
    const { result } = renderHook(() => useCanvasCommandCenter(options));
    result.current({ kind: "draw-diagram", topic: "New", graph: { nodes: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], edges: [] } });
    const application = (options.commitAgentDraw as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { removeIds: string[] };
    expect(application.removeIds).toEqual([]);
  });

  it("creates and focuses notes through the command surface", () => {
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    expect(result.current({ kind: "create-node", nodeType: "note", at: { x: 1, y: 2 }, content: "hello" })).toEqual({ nodeId: "note-1" });

    expect(options.addNoteNode).toHaveBeenCalledWith({ x: 1, y: 2 }, "hello");
    expect(options.focusNode).toHaveBeenCalledWith("note-1");
  });

  it("arranges the canvas through the command surface", () => {
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    expect(result.current({ kind: "arrange-layout" })).toEqual({});
    expect(options.arrangeNodes).toHaveBeenCalledOnce();
  });

  it("can create without focusing", () => {
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "create-node", nodeType: "terminal", focus: false });

    expect(options.addTerminalNode).toHaveBeenCalledOnce();
    expect(options.focusNode).not.toHaveBeenCalled();
  });

  it("creates note drop targets at a centered screen position", () => {
    const flowInstance = { screenToFlowPosition: vi.fn(() => ({ x: 42, y: 64 })) } as unknown as CanvasCommandCenterOptions["flowInstance"];
    const options = makeOptions({ flowInstance });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "create-note-drop-target", screen: { x: 100, y: 200 }, content: "drop" });

    expect(flowInstance?.screenToFlowPosition).toHaveBeenCalled();
    expect(options.addNoteNode).toHaveBeenCalledWith(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }), "drop");
    expect(options.focusNode).toHaveBeenCalledWith("note-1");
  });

  it("spawns multiple agents from the viewport center with a small cascade when no explicit position is supplied", () => {
    const flowInstance = { screenToFlowPosition: vi.fn(() => ({ x: 1000, y: 800 })) } as unknown as CanvasCommandCenterOptions["flowInstance"];
    const options = makeOptions({ flowInstance });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "create-agent", definition: agentDef, focus: false });
    result.current({ kind: "create-agent", definition: agentDef, focus: false });

    expect(options.addAgentNode).toHaveBeenNthCalledWith(1, agentDef, { x: 640, y: 540 }, undefined);
    expect(options.addAgentNode).toHaveBeenNthCalledWith(2, agentDef, { x: 1396, y: 540 }, undefined);
  });

  // Regression: only note + agent used to get a viewport-centred spawn. Every other kind fell back to
  // cascadePosition(nodes.length) — absolute WORLD coords — so a voice "spawn a terminal" while panned
  // away landed the node off-screen. With tidyOnOpen on (the default) auto-focus is suppressed, so the
  // node stayed invisible until the debounced tidy yanked the whole board: the reported glitch.
  it("spawns every create-node kind at the viewport centre, not at a world-coordinate cascade", () => {
    const flowInstance = { screenToFlowPosition: vi.fn(() => ({ x: 1000, y: 800 })) } as unknown as CanvasCommandCenterOptions["flowInstance"];
    const options = makeOptions({ flowInstance });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    // addTaskNode is (seed, at); every other factory is (at).
    const centred = (mock: unknown, argIndex = 0) =>
      (mock as { mock: { calls: unknown[][] } }).mock.calls[0][argIndex] as { x: number; y: number } | undefined;

    result.current({ kind: "create-node", nodeType: "terminal", focus: false });
    result.current({ kind: "create-node", nodeType: "plan", focus: false });
    result.current({ kind: "create-node", nodeType: "task", focus: false });
    result.current({ kind: "create-node", nodeType: "context", focus: false });
    result.current({ kind: "create-node", nodeType: "critic", focus: false });
    result.current({ kind: "create-node", nodeType: "human-gate", focus: false });
    result.current({ kind: "create-node", nodeType: "team", focus: false });
    result.current({ kind: "create-node", nodeType: "music", focus: false });

    for (const [label, mock, argIndex] of [
      ["terminal", options.addTerminalNode, 0],
      ["plan", options.addPlanNode, 0],
      ["task", options.addTaskNode, 1],
      ["context", options.addContextNode, 0],
      ["critic", options.addCriticNode, 0],
      ["human-gate", options.addHumanGateNode, 0],
      ["team", options.addTeamNode, 0],
      ["music", options.addMusicNode, 0],
    ] as const) {
      const at = centred(mock, argIndex);
      expect(at, `${label} spawn position`).toEqual({ x: expect.any(Number), y: expect.any(Number) });
      // Derived from the projected viewport centre (1000, 800), never from the world-origin cascade.
      expect(Math.abs((at as { x: number }).x - 1000), `${label} x near viewport centre`).toBeLessThan(1000);
    }
  });

  it("creates a Run Node from member ids, and reports when none can be claimed", () => {
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    expect(result.current({ kind: "create-run", memberIds: ["a", "b"] })).toEqual({ nodeId: "run-1" });
    expect(options.addRunNode).toHaveBeenCalledWith(["a", "b"]);
    expect(result.current({ kind: "create-run", memberIds: [] }).error).toMatch(/can join a run/);
  });

  it("honours an explicit position for create-node instead of re-centring it", () => {
    const flowInstance = { screenToFlowPosition: vi.fn(() => ({ x: 1000, y: 800 })) } as unknown as CanvasCommandCenterOptions["flowInstance"];
    const options = makeOptions({ flowInstance });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "create-node", nodeType: "terminal", at: { x: 7, y: 9 }, focus: false });

    expect(options.addTerminalNode).toHaveBeenCalledWith({ x: 7, y: 9 });
  });

  it("leaves the position undefined when there is no flow instance, so the factory cascade still applies", () => {
    const options = makeOptions({ flowInstance: null });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "create-node", nodeType: "terminal", focus: false });

    expect(options.addTerminalNode).toHaveBeenCalledWith(undefined);
  });

  it("routes agent and browser creation", () => {
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "create-agent", definition: agentDef, at: { x: 3, y: 4 }, options: { isolate: true, teamLabel: "team" } });
    result.current({ kind: "create-browser", url: "https://example.com" });

    expect(options.addAgentNode).toHaveBeenCalledWith(agentDef, { x: 3, y: 4 }, { isolate: true, teamLabel: "team" });
    expect(options.spawnStandaloneBrowserNode).toHaveBeenCalledWith("https://example.com");
  });

  it("routes skills commands and focuses related nodes", () => {
    const options = makeOptions({
      edges: [{ id: "edge-1", source: "term-1", target: "skills-1" }],
    });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "add-skills", terminalId: "term-1", cwd: "/repo" });
    result.current({ kind: "open-skill", skillsNodeId: "skills-1", skill: skillPreview });

    expect(options.addSkillsNode).toHaveBeenCalledWith("term-1", "/repo");
    expect(options.focusNodes).toHaveBeenCalledWith(["term-1", "skills-1"], "skills-1");
    expect(options.addSkillNode).toHaveBeenCalledWith(skillPreview, "skills-1");
    expect(options.focusNodes).toHaveBeenLastCalledWith(["term-1", "skills-1", "skill-1"], "skill-1");
  });

  it("toggles browser nodes for a terminal", () => {
    const existingBrowser = { id: "browser-1", type: "browser", position: { x: 0, y: 0 }, data: {} };
    const options = makeOptions({
      nodes: [existingBrowser],
      edges: [{ id: "edge-1", source: "term-1", target: "browser-1" }],
    });
    const { result, rerender } = renderHook(({ currentOptions }) => useCanvasCommandCenter(currentOptions), { initialProps: { currentOptions: options } });

    result.current({ kind: "toggle-browser", terminalId: "term-1" });
    expect(options.closeBrowserNode).toHaveBeenCalledWith("browser-1");

    const nextOptions = makeOptions();
    rerender({ currentOptions: nextOptions });
    result.current({ kind: "toggle-browser", terminalId: "term-1", url: "https://example.com" });
    expect(nextOptions.spawnBrowserNode).toHaveBeenCalledWith("term-1", "https://example.com");
  });

  it("opens or navigates a terminal browser without closing the existing node", () => {
    const existingBrowser = {
      id: "browser-1",
      type: "browser",
      position: { x: 0, y: 0 },
      data: { state: "active" },
    };
    const options = makeOptions({
      nodes: [existingBrowser],
      edges: [{ id: "edge-1", source: "term-1", target: "browser-1" }],
    });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    expect(result.current({ kind: "open-browser-for-terminal", terminalId: "term-1", url: "https://youtube.com" })).toEqual({ nodeId: "browser-1" });

    expect(options.closeBrowserNode).not.toHaveBeenCalled();
    expect(options.patchNodeData).toHaveBeenCalledWith("browser-1", { url: "https://youtube.com", state: "active" });
    expect(options.focusNode).toHaveBeenCalledWith("browser-1");
    expect(canvasBrowserApi.navigateCanvasBrowser).toHaveBeenCalledWith("term-1", "https://youtube.com");
  });

  it("navigates a standalone BrowserNode through its native browser id", () => {
    const browserNode = {
      id: "browser-1",
      type: "browser",
      position: { x: 0, y: 0 },
      data: { parentTerminalId: null, state: "active" },
    };
    const options = makeOptions({ nodes: [browserNode] });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    expect(result.current({ kind: "navigate-browser-node", nodeId: "browser-1", url: "https://www.youtube.com/" })).toEqual({ nodeId: "browser-1" });

    expect(options.patchNodeData).toHaveBeenCalledWith("browser-1", { url: "https://www.youtube.com/", state: "active" });
    expect(options.focusNode).toHaveBeenCalledWith("browser-1");
    expect(canvasBrowserApi.navigateCanvasBrowser).toHaveBeenCalledWith("browser-1", "https://www.youtube.com/");
  });

  it("navigates a paired BrowserNode through its parent terminal native id", () => {
    const browserNode = {
      id: "browser-1",
      type: "browser",
      position: { x: 0, y: 0 },
      data: { parentTerminalId: "term-1", state: "active" },
    };
    const options = makeOptions({
      nodes: [browserNode],
      edges: [{ id: "edge-1", source: "term-1", target: "browser-1" }],
    });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    expect(result.current({ kind: "navigate-browser-node", nodeId: "browser-1", url: "https://www.youtube.com/" })).toEqual({ nodeId: "browser-1" });

    expect(canvasBrowserApi.navigateCanvasBrowser).toHaveBeenCalledWith("term-1", "https://www.youtube.com/");
  });

  it("routes existing-node commands", () => {
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    const draft: SmartConvertDraft = {
      title: "Ship it",
      intent: "release",
      taskClass: "quick",
      when: "urgent",
      acceptanceCriteria: [{ id: "ac-1", text: "done", done: false }],
      subtasks: [],
    };

    result.current({ kind: "focus-node", nodeId: "node-1" });
    result.current({ kind: "close-node", nodeId: "node-2" });
    result.current({ kind: "close-all-nodes" });
    result.current({ kind: "dispatch-task", nodeId: "task-2", mode: "team" });
    result.current({ kind: "patch-node", nodeId: "node-3", patch: { title: "Updated" } });
    result.current({ kind: "recover-browser", nodeId: "browser-1" });
    result.current({ kind: "convert-note-to-task", nodeId: "note-1", draft });

    expect(options.focusNode).toHaveBeenCalledWith("node-1");
    expect(options.focusNode).toHaveBeenCalledWith("browser-1");
    // Cleanup starts immediately; the close owner waits for the animation before graph removal.
    expect(options.markNodeLeaving).toHaveBeenCalledWith("node-2");
    expect(options.removeAllNodes).toHaveBeenCalled();
    expect(options.dispatchTask).toHaveBeenCalledWith("task-2", "team", undefined, undefined);
    expect(options.patchNodeData).toHaveBeenCalledWith("node-3", { title: "Updated" });
    expect(options.patchNodeData).toHaveBeenCalledWith("browser-1", { state: "loading" });
    expect(options.convertNoteToTask).toHaveBeenCalledWith("note-1", draft);
  });

  it("close-all cascades the leave animation, then clears the graph once the last node finishes", () => {
    vi.useFakeTimers();
    const options = makeOptions({ markAllNodesLeaving: vi.fn(() => 210) });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "close-all-nodes" });
    // Every node is tagged as leaving immediately; the graph clear waits for the cascade.
    expect(options.markAllNodesLeaving).toHaveBeenCalledOnce();
    expect(options.removeAllNodes).toHaveBeenCalledWith(210);

    vi.advanceTimersByTime(220);
    expect(options.removeAllNodes).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("close-all clears immediately when there is nothing to animate", () => {
    const options = makeOptions({ markAllNodesLeaving: vi.fn(() => 0) });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "close-all-nodes" });
    expect(options.removeAllNodes).toHaveBeenCalledOnce();
  });

  it("close-node plays the leave animation, then removes the node after the delay", () => {
    vi.useFakeTimers();
    const options = makeOptions();
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "close-node", nodeId: "node-9" });
    // Tag the node and start shutdown now; pass the animation delay to the close owner.
    expect(options.markNodeLeaving).toHaveBeenCalledWith("node-9");
    expect(options.removeNode).toHaveBeenCalledWith("node-9", 300);

    vi.advanceTimersByTime(310);
    expect(options.removeNode).toHaveBeenCalledWith("node-9", 300);
    vi.useRealTimers();
  });

  it("recovers terminal nodes by rotating the runtime pane id", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234);
    const options = makeOptions({
      nodes: [{ id: "term-1", type: "terminal", position: { x: 0, y: 0 }, data: { runtimeScope: "canvas:project", runtimePaneId: "canvas:project:term-1" } }],
    });
    const { result } = renderHook(() => useCanvasCommandCenter(options));

    result.current({ kind: "recover-terminal", nodeId: "term-1" });

    expect(options.patchNodeData).toHaveBeenCalledWith("term-1", { runtimePaneId: "canvas:project:term-1:recover:1234" });
    expect(options.focusNode).toHaveBeenCalledWith("term-1");
    nowSpy.mockRestore();
  });
});
