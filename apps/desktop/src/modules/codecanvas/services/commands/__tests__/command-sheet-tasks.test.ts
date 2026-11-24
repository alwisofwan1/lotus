import { describe, it, expect, vi } from "vitest";
import { buildCommandSheetItems, filterCommandSheetItems, GROUP_LABEL, shouldAutoOpenSheet, type SheetTrackerTask } from "../command-sheet-items";

/** ⌘K "From Tasks…" (plans/canvas-dock board 18, decision 6). */

const tasks: SheetTrackerTask[] = [
  { id: "t1", workspaceId: "ws", title: "Rilis 2 backlog", key: "FT-12", workspaceName: "Flow Trader", statusLabel: "In Progress", nodeId: null },
  { id: "t2", workspaceId: "ws", title: "Fix login redirect", key: "FT-13", workspaceName: "Flow Trader", statusLabel: "Todo", nodeId: "node-9" },
];
const taskRows = (items: ReturnType<typeof buildCommandSheetItems>) => items.filter((item) => item.group === "tasks");

describe("placing a task from ⌘K", () => {
  it("lists each task under From Tasks…, and a row hands that task to the canvas", () => {
    const onPlaceTask = vi.fn();
    const rows = taskRows(buildCommandSheetItems({ nodes: [], clis: [], trackerTasks: tasks, onPlaceTask }));
    expect(GROUP_LABEL.tasks).toBe("From Tasks…");
    expect(rows.map((r) => [r.title, r.detail, r.tag])).toEqual([
      ["Rilis 2 backlog", "FT-12 · Flow Trader · In Progress", "ADD"],
      ["Fix login redirect", "FT-13 · Flow Trader · Todo · on this canvas", "GO"],
    ]);
    const action = rows[1]!.action;
    if (action.kind === "custom") action.run();
    expect(onPlaceTask).toHaveBeenCalledWith(tasks[1]);
    // ⌘↵: place it and open its row in the Dock's Tasks.
    if (action.kind === "custom") action.alt!.run();
    expect(onPlaceTask).toHaveBeenLastCalledWith(tasks[1], { openInDock: true });
    expect(action.kind === "custom" && action.alt!.hint).toBe("open in Tasks");
  });

  it("finds a task by its key or title", () => {
    const items = buildCommandSheetItems({ nodes: [], clis: [], trackerTasks: tasks, onPlaceTask: vi.fn() });
    expect(filterCommandSheetItems(items, "ft-13")[0]!.title).toBe("Fix login redirect");
    expect(filterCommandSheetItems(items, "rilis")[0]!.title).toBe("Rilis 2 backlog");
  });

  it("never opens the sheet over prose by itself", () => {
    const items = buildCommandSheetItems({ nodes: [], clis: [], trackerTasks: tasks, onPlaceTask: vi.fn() });
    expect(shouldAutoOpenSheet(items, "fix login redirect")).toBe(false);
  });

  it("shows nothing when the canvas cannot place a task", () => {
    expect(taskRows(buildCommandSheetItems({ nodes: [], clis: [], trackerTasks: tasks }))).toEqual([]);
  });
});
