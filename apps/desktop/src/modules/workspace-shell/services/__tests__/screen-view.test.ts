import { describe, expect, it } from "vitest";
import {
  createTerminalV2LayoutFromPaneIds,
  getTerminalV2LayoutPaneIds,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import type { CodeFrame, GridCell, Workspace } from "@/modules/codespace/components/types";
import { screenViewOf } from "@/modules/workspace-shell/services/screen-view";

const cell = (id: string) => ({ id }) as GridCell;
const workspace = (over: Partial<Workspace> = {}): Workspace =>
  ({ id: "ws", label: "ws", color: "", cwd: "/", rows: 1, cols: 1, cells: [cell("a"), cell("b")], ...over }) as Workspace;
const frame = (id: string, paneIds: string[]): CodeFrame => ({
  id,
  name: id,
  color: "violet",
  createdAt: 1,
  paneIds,
  layout: paneIds.length ? createTerminalV2LayoutFromPaneIds(paneIds, paneIds[0] ?? null) : null,
});
const framed = (frames: CodeFrame[], cells = ["a", "b", "c"]) =>
  workspace({ cells: cells.map(cell), paneLayout: { mode: "grid", frames, framesMigrated: true } });

describe("screenViewOf — before Frames exist", () => {
  it("shows the whole workspace: every pane, in the workspace's own split", () => {
    const layout = createTerminalV2LayoutFromPaneIds(["a", "b"], "a");
    const ws = workspace({ paneLayout: { mode: "grid", focusCellId: null, terminalV2Layout: layout } });

    const view = screenViewOf(ws);

    expect(view.kind).toBe("workspace");
    expect(view.workspaceId).toBe("ws");
    expect(view.cells.map((c) => c.id)).toEqual(["a", "b"]);
    expect(view.layout).toBe(layout);
  });

  it("has no split for a workspace that was never split, so the grid draws it", () => {
    expect(screenViewOf(workspace()).layout).toBeNull();
  });
});

describe("screenViewOf — with Frames", () => {
  it("shows only the focused pane's Frame, in that Frame's own layout", () => {
    const f = frame("f", ["a", "b"]);
    const view = screenViewOf(framed([f]), { focusedPaneId: "b" });

    expect(view).toMatchObject({ kind: "frame", frameId: "f", layout: f.layout });
    expect(view.cells.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("shows a focused loose pane alone", () => {
    const view = screenViewOf(framed([frame("f", ["a", "b"])]), { focusedPaneId: "c" });

    expect(view).toMatchObject({ kind: "pane", paneId: "c" });
    expect(view.cells.map((c) => c.id)).toEqual(["c"]);
    expect(getTerminalV2LayoutPaneIds(view.layout?.root ?? null)).toEqual(["c"]);
  });

  it("leaves a closed pane out of its Frame's view", () => {
    const view = screenViewOf(framed([frame("f", ["a", "b"])], ["a", "c"]), { focusedPaneId: "a" });
    expect(getTerminalV2LayoutPaneIds(view.layout?.root ?? null)).toEqual(["a"]);
  });

  it("opens an empty Frame when asked, since no pane can be focused in it", () => {
    const view = screenViewOf(framed([frame("f", ["a"]), frame("e", [])]), { focusedPaneId: "a", openFrameId: "e" });
    expect(view).toMatchObject({ kind: "frame", frameId: "e", cells: [], layout: null });
  });

  it("opens an empty Frame in a workspace that has no panes at all", () => {
    const view = screenViewOf(framed([frame("e", [])], []), { openFrameId: "e" });
    expect(view).toMatchObject({ kind: "frame", frameId: "e", cells: [], layout: null });
  });

  it("follows focus over a Frame that is open but no longer empty", () => {
    const view = screenViewOf(framed([frame("f", ["a"]), frame("e", ["b"])]), { focusedPaneId: "a", openFrameId: "e" });
    expect(view).toMatchObject({ kind: "frame", frameId: "f" });
  });
});
