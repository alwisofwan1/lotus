import { describe, expect, it } from "vitest";
import { rememberedFocusCellId } from "@/modules/codespace/services/workspace-focus-memory";
import { createTerminalV2LayoutFromPaneIds } from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";

function workspace(paneIds: string[], activePaneId?: string): Pick<Workspace, "cells" | "paneLayout"> {
  return {
    cells: paneIds.map((id) => ({ id, cwd: "/tmp", type: "terminal", runtimeSessionId: null, runtimeStatus: "idle" })) as GridCell[],
    paneLayout: activePaneId
      ? { mode: "grid", terminalV2Layout: createTerminalV2LayoutFromPaneIds(paneIds, activePaneId) }
      : undefined,
  };
}

describe("rememberedFocusCellId", () => {
  it("returns the pane the workspace's layout was left on", () => {
    expect(rememberedFocusCellId(workspace(["a", "b", "c"], "b"))).toBe("b");
  });

  it("falls back to the first pane when nothing was remembered", () => {
    expect(rememberedFocusCellId(workspace(["a", "b"]))).toBe("a");
  });

  it("falls back when the remembered pane was closed while the folder was away", () => {
    const stale = workspace(["a", "b"], "b");
    stale.cells = stale.cells.filter((cell) => cell.id !== "b");
    expect(rememberedFocusCellId(stale)).toBe("a");
  });

  it("has nothing to return for an empty or missing workspace", () => {
    expect(rememberedFocusCellId(workspace([]))).toBeNull();
    expect(rememberedFocusCellId(undefined)).toBeNull();
  });
});
