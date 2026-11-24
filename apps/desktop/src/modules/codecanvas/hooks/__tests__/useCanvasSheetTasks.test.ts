import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { SharedTrackerBoard } from "@/modules/workspace-shell/hooks/TrackerBoardProvider";
import type { TrackerTask } from "@/modules/tasks/types";
import { useCanvasSheetTasks } from "../useCanvasSheetTasks";

const make = (id: string, projectId: string, status: string, updatedAt: number): TrackerTask =>
  ({ id, projectId, number: Number(id.slice(1)), title: `Task ${id}`, status, priority: "none", createdAt: 1, updatedAt }) as TrackerTask;
const vocabulary = { order: ["todo", "in-progress", "done"], labels: { todo: "Todo", "in-progress": "In Progress", done: "Done" }, tones: {}, open: ["todo", "in-progress"] };
const projects = [
  { id: "ws-other", name: "Other", prefix: "OT", vocabulary },
  { id: "ws-home", name: "Home", prefix: "HM", vocabulary },
];
const shared = {
  board: {
    loading: false,
    projects,
    projectsById: new Map(projects.map((p) => [p.id, p])),
    tasks: [make("t1", "ws-other", "todo", 50), make("t2", "ws-home", "in-progress", 10), make("t3", "ws-home", "done", 99), make("t4", "ws-home", "todo", 20)],
  },
} as unknown as SharedTrackerBoard;
const linked = { id: "node-4", type: "task", position: { x: 0, y: 0 }, data: { taskId: "t4", title: "x" } } as Node;

function setup() {
  const addTaskNode = vi.fn(() => "node-new");
  const revealNode = vi.fn();
  const openInDock = vi.fn();
  const hook = renderHook(() => useCanvasSheetTasks({ nodes: [linked], shared, boardWorkspaceId: "ws-home", addTaskNode, revealNode, openInDock }));
  return { ...hook, addTaskNode, revealNode, openInDock };
}

describe("useCanvasSheetTasks (board 18, decision 6)", () => {
  it("lists open tasks only, this board's workspace first, then the most recently touched", () => {
    const { result } = setup();
    expect(result.current.trackerTasks!.map((t) => [t.id, t.key, t.statusLabel, t.nodeId])).toEqual([
      ["t4", "HM-4", "Todo", "node-4"],
      ["t2", "HM-2", "In Progress", null],
      ["t1", "OT-1", "Todo", null],
    ]);
  });

  it("places a task as a linked node and shows it", () => {
    const { result, addTaskNode, revealNode } = setup();
    act(() => result.current.placeTask!(result.current.trackerTasks![1]!));
    expect(addTaskNode).toHaveBeenCalledWith({ title: "Task t2", taskId: "t2", taskWorkspaceId: "ws-home" });
    expect(revealNode).toHaveBeenCalledWith("node-new");
  });

  it("centres the node a task already has instead of placing it twice", () => {
    const { result, addTaskNode, revealNode } = setup();
    act(() => result.current.placeTask!(result.current.trackerTasks![0]!));
    expect(addTaskNode).not.toHaveBeenCalled();
    expect(revealNode).toHaveBeenCalledWith("node-4");
  });

  it("with ⌘↵ also opens the task's row in the Dock", () => {
    const { result, openInDock, revealNode } = setup();
    act(() => result.current.placeTask!(result.current.trackerTasks![1]!, { openInDock: true }));
    expect(revealNode).toHaveBeenCalledWith("node-new");
    expect(openInDock).toHaveBeenCalledWith("t2");
  });

  it("offers nothing without a tracker board", () => {
    const { result } = renderHook(() => useCanvasSheetTasks({ nodes: [], shared: null, boardWorkspaceId: null, addTaskNode: vi.fn(), revealNode: vi.fn() }));
    expect(result.current.trackerTasks).toBeUndefined();
    expect(result.current.placeTask).toBeUndefined();
  });
});
