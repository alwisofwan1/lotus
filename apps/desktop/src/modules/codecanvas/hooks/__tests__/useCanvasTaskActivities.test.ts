import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";

const statusSubscribers = new Map<string, (status: string) => void>();
const activitySubscribers = new Map<string, (activity: string) => void>();
vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  attachCellBus: () => () => {},
  subscribeTerminalSessionStatus: (paneId: string, subscriber: (status: string) => void) => {
    statusSubscribers.set(paneId, subscriber);
    subscriber("idle");
    return () => statusSubscribers.delete(paneId);
  },
}));
vi.mock("@/modules/codespace/services/terminal-activity-registry", () => ({
  subscribeTerminalActivity: (paneId: string, subscriber: (activity: string) => void) => {
    activitySubscribers.set(paneId, subscriber);
    return () => activitySubscribers.delete(paneId);
  },
  getTerminalActivitySince: () => undefined,
}));
vi.mock("@/modules/codecanvas/hooks/useAgentTurnFacts", () => ({ useAgentTurnFacts: () => {} }));
vi.mock("@/modules/workspace-shell/services/diagnostic-trace", () => ({ appendDiagnosticTrace: () => {} }));

const { canvasPaneNodes, canvasTaskCells, useCanvasTaskActivities } = await import("../useCanvasTaskActivities");

const terminal = (id: string, data: Record<string, unknown>) => ({ id, type: "terminal", position: { x: 0, y: 0 }, data }) as Node;
const taskCell = terminal("node-1", { spawnTaskKey: "t1", runtimePaneId: "canvas:cp_1:node-1", launchCommand: ["claude", "--session-id", "s1"] });
const handOpened = terminal("node-2", { runtimePaneId: "canvas:cp_1:node-2" });

describe("canvasTaskCells", () => {
  it("takes only the terminals opened for a task, by the pane id their agent reports as", () => {
    expect(canvasTaskCells([taskCell, handOpened])).toEqual([{ paneId: "canvas:cp_1:node-1", agentCommand: "claude --session-id s1" }]);
  });
});

describe("useCanvasTaskActivities", () => {
  it("publishes what a task cell is doing, and clears it when the canvas goes", () => {
    const publish = vi.fn();
    const { unmount } = renderHook(() => useCanvasTaskActivities([taskCell, handOpened], publish));
    const lastActivity = () => (publish.mock.calls.at(-1)![0] as ReadonlyMap<string, { activity: string }>).get("canvas:cp_1:node-1")?.activity;

    expect(lastActivity()).toBe("offline");
    act(() => statusSubscribers.get("canvas:cp_1:node-1")!("live"));
    act(() => activitySubscribers.get("canvas:cp_1:node-1")!("running"));
    expect(lastActivity()).toBe("working");
    // The agent exiting ends the pane, which is what lets the recorder write the task's ending.
    act(() => statusSubscribers.get("canvas:cp_1:node-1")!("exited"));
    expect(lastActivity()).toBe("done");
    expect(statusSubscribers.has("canvas:cp_1:node-2")).toBe(false);

    unmount();
    expect((publish.mock.calls.at(-1)![0] as Map<string, unknown>).size).toBe(0);
  });
});

describe("canvasPaneNodes", () => {
  it("maps each terminal's runtime pane id to its node, a hand-opened shell too", () => {
    const nodes = [
      { id: "n1", type: "terminal", position: { x: 0, y: 0 }, data: { runtimePaneId: "p1", spawnTaskKey: "t1" } },
      { id: "n2", type: "terminal", position: { x: 0, y: 0 }, data: { runtimePaneId: "p2" } },
      { id: "n3", type: "note", position: { x: 0, y: 0 }, data: { runtimePaneId: "p3" } },
    ] as Node[];
    expect([...canvasPaneNodes(nodes)]).toEqual([["p1", "n1"], ["p2", "n2"]]);
  });
});
