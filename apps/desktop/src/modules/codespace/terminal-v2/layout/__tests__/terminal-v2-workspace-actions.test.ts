import { describe, expect, it } from "vitest";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import {
  applyTerminalV2WorkspaceFocus,
  applyTerminalV2WorkspaceRemove,
  applyTerminalV2WorkspaceSplit,
} from "../terminal-v2-workspace-actions";

function terminalCell(id: string): GridCell {
  return {
    id,
    type: "terminal",
    cwd: "/repo",
    runtimeSessionId: null,
    runtimeStatus: "idle",
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1",
    label: "Workspace",
    color: "#fff",
    cwd: "/repo",
    location: { kind: "local", cwd: "/repo" },
    rows: 1,
    cols: 1,
    rowFractions: [1],
    colFractions: [1],
    cells: [terminalCell("pane-1")],
    ...overrides,
  };
}

describe("terminal-v2-workspace-actions", () => {
  it("applies V2 split metadata while preserving legacy grid tracks", () => {
    const source = workspace({
      paneLayout: {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: {
          root: { kind: "leaf", paneId: "pane-1" },
          activePaneId: "pane-1",
        },
      },
    });

    const next = applyTerminalV2WorkspaceSplit(source, {
      sourcePaneId: "pane-1",
      newCell: terminalCell("pane-2"),
      direction: "horizontal",
    });

    expect(next.cells.map((cell) => cell.id)).toEqual(["pane-1", "pane-2"]);
    expect(next.cols).toBe(1);
    expect(next.colFractions).toEqual([1]);
    expect(next.paneLayout?.terminalV2Layout).toEqual({
      root: {
        kind: "split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { kind: "leaf", paneId: "pane-1" },
          { kind: "leaf", paneId: "pane-2" },
        ],
      },
      activePaneId: "pane-2",
    });
  });

  it("keeps legacy split grid updates when no V2 metadata exists", () => {
    const next = applyTerminalV2WorkspaceSplit(workspace(), {
      sourcePaneId: "pane-1",
      newCell: terminalCell("pane-2"),
      direction: "vertical",
    });

    expect(next.cells.map((cell) => cell.id)).toEqual(["pane-1", "pane-2"]);
    expect(next.rows).toBe(2);
    expect(next.rowFractions).toEqual([0.5, 0.5]);
    expect(next.paneLayout).toBeUndefined();
  });

  it("applies V2 remove metadata while preserving legacy grid tracks", () => {
    const source = workspace({
      cols: 2,
      colFractions: [0.5, 0.5],
      cells: [terminalCell("pane-1"), terminalCell("pane-2")],
      paneLayout: {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: {
          root: {
            kind: "split",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { kind: "leaf", paneId: "pane-1" },
              { kind: "leaf", paneId: "pane-2" },
            ],
          },
          activePaneId: "pane-2",
        },
      },
    });

    const next = applyTerminalV2WorkspaceRemove(source, "pane-2");

    expect(next.cells.map((cell) => cell.id)).toEqual(["pane-1"]);
    expect(next.cols).toBe(2);
    expect(next.colFractions).toEqual([0.5, 0.5]);
    expect(next.paneLayout?.terminalV2Layout).toEqual({
      root: { kind: "leaf", paneId: "pane-1" },
      activePaneId: "pane-1",
    });
  });

  it("updates V2 active pane metadata on focus", () => {
    const source = workspace({
      cells: [terminalCell("pane-1"), terminalCell("pane-2")],
      paneLayout: {
        mode: "grid",
        focusCellId: null,
        terminalV2Layout: {
          root: {
            kind: "split",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { kind: "leaf", paneId: "pane-1" },
              { kind: "leaf", paneId: "pane-2" },
            ],
          },
          activePaneId: "pane-1",
        },
      },
    });

    expect(applyTerminalV2WorkspaceFocus(source, "pane-2").paneLayout?.terminalV2Layout?.activePaneId).toBe("pane-2");
    const legacy = workspace();
    expect(applyTerminalV2WorkspaceFocus(legacy, "missing")).toBe(legacy);
  });
});
