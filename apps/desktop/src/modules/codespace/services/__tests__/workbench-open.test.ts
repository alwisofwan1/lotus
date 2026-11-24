import { describe, expect, it, vi } from "vitest";
import {
  canSplitEditor,
  onEditorSplit,
  onWorkbenchOpen,
  requestEditorSplit,
  openFileLinkInWorkspace,
  onFileLinkOpen,
  requestWorkbenchOpen,
  takeWorkbenchOpen,
} from "@/modules/codespace/services/workbench-open";

describe("workbench open queue", () => {
  it("keeps a request for a pane that has not mounted yet", () => {
    requestWorkbenchOpen("cell-new", { path: "/repo/a.ts", startLine: 3, endLine: 4 });
    expect(takeWorkbenchOpen("cell-new")).toEqual({ path: "/repo/a.ts", startLine: 3, endLine: 4 });
    expect(takeWorkbenchOpen("cell-new")).toBeNull();
  });

  it("tells a mounted pane, and only that pane", () => {
    const mine = vi.fn();
    const other = vi.fn();
    const offMine = onWorkbenchOpen("cell-1", mine);
    const offOther = onWorkbenchOpen("cell-2", other);

    requestWorkbenchOpen("cell-1", { path: "/repo/a.ts" });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    offMine();
    offOther();
    takeWorkbenchOpen("cell-1");
  });
});

describe("file link requests", () => {
  it("goes to whoever handles the workspace and returns its answer", () => {
    const handler = vi.fn().mockReturnValue({ ok: false, reason: "no" });
    const off = onFileLinkOpen(handler);

    expect(openFileLinkInWorkspace("ws-1", { path: "a.ts" })).toEqual({ ok: false, reason: "no" });
    expect(handler).toHaveBeenCalledWith("ws-1", { path: "a.ts" });
    off();
  });

  it("says so when nothing can open files here", () => {
    expect(openFileLinkInWorkspace("ws-1", { path: "a.ts" })).toEqual({
      ok: false,
      reason: "Files open in an Editor pane. There is none in this view.",
    });
  });
});

describe("editor split (LOT2-210)", () => {
  it("has nothing to split into until the shell answers", () => {
    expect(canSplitEditor("cell-1")).toBe(false);
    expect(requestEditorSplit("cell-1", "/r/a.ts")).toBe(false);
  });

  it("hands the pane and file to the shell that holds the pane", () => {
    const split = vi.fn();
    const stop = onEditorSplit({ holds: (cellId) => cellId === "cell-1", split });
    expect(canSplitEditor("cell-1")).toBe(true);
    expect(requestEditorSplit("cell-1", "/r/a.ts")).toBe(true);
    expect(split).toHaveBeenCalledWith("cell-1", "/r/a.ts");
    stop();
    expect(canSplitEditor("cell-1")).toBe(false);
  });

  it("leaves a pane the shell does not hold alone", () => {
    const split = vi.fn();
    const stop = onEditorSplit({ holds: () => false, split });
    expect(canSplitEditor("grid-cell")).toBe(false);
    expect(requestEditorSplit("grid-cell", "/r/a.ts")).toBe(false);
    expect(split).not.toHaveBeenCalled();
    stop();
  });
});
