import { describe, expect, it } from "vitest";
import { paneFileDropAttributes, shellTerminalDropCells } from "@/modules/workspace-shell/services/pane-file-drop";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";

function terminal(id: string, patch: Partial<Extract<GridCell, { type: "terminal" }>> = {}): GridCell {
  return { id, type: "terminal", cwd: `/repo/${id}`, ...patch };
}

function workspace(cells: GridCell[], patch: Partial<Workspace> = {}): Workspace {
  return { id: "ws", label: "ws", color: "#000", cwd: "/repo", rows: 1, cols: 1, cells, ...patch };
}

describe("shellTerminalDropCells", () => {
  it("offers only terminal panes as drop targets", () => {
    const cells = [
      terminal("t1"),
      { id: "c1", type: "chat", cwd: "/repo", sessionId: "s1" } as GridCell,
      { id: "b1", type: "browser", cwd: "/repo", url: "https://x.test" } as GridCell,
    ];

    const targets = shellTerminalDropCells({
      workspace: workspace(cells),
      focusMode: false,
      focusedPaneId: null,
    });

    expect(targets.map((cell) => cell.id)).toEqual(["t1"]);
  });

  /**
   * Focus mode hides the other panes with CSS, and a drop is resolved by hit-testing the DOM. Two
   * stylesheets decide that hiding — the split tree's and the grid's — so a rule that stops
   * matching would silently make an off-screen terminal receive somebody's file. Leaving a hidden
   * pane out of the target list is a second lock that no stylesheet can open.
   */
  it("drops a pane that focus mode has taken off screen", () => {
    const targets = shellTerminalDropCells({
      workspace: workspace([terminal("t1"), terminal("t2")]),
      focusMode: true,
      focusedPaneId: "t2",
    });

    expect(targets.map((cell) => cell.id)).toEqual(["t2"]);
  });

  /**
   * The drop handler reads the status to decide between writing now, queueing until the PTY is
   * live, and refusing. Dropping the field would make every pane look `idle` and every drop be
   * refused.
   */
  it("carries each terminal's own cwd and runtime status", () => {
    const targets = shellTerminalDropCells({
      workspace: workspace([terminal("t1", { cwd: "/repo/api", runtimeStatus: "starting" })]),
      focusMode: false,
      focusedPaneId: null,
    });

    expect(targets).toEqual([{ id: "t1", type: "terminal", cwd: "/repo/api", runtimeStatus: "starting" }]);
  });
});

describe("paneFileDropAttributes", () => {
  /**
   * The attribute names are a contract with `useTerminalFileDrop`, which finds the pane under a
   * native drop by querying `[data-terminal-file-drop-target='true']` and then reads the rest off
   * that element's dataset. They are spelled out here so renaming one side breaks a test rather
   * than the feature.
   */
  it("marks a terminal pane with everything the drop handler reads", () => {
    expect(
      paneFileDropAttributes(terminal("t1", { cwd: "/repo/api", runtimeStatus: "live" }), workspace([])),
    ).toEqual({
      "data-terminal-file-drop-target": "true",
      "data-terminal-file-drop-cell-id": "t1",
      "data-terminal-file-drop-cwd": "/repo/api",
      "data-terminal-file-drop-status": "live",
      "data-terminal-file-drop-location": "local",
    });
  });

  /**
   * A remote workspace runs its shell on another machine, so a local path typed into it names a
   * file that host cannot see. Saying "ssh" here is what sends the drop through the upload path
   * instead, and what makes the overlay promise an upload rather than a paste.
   */
  it("sends a remote workspace's drop down the upload path", () => {
    const remote = workspace([], { location: { kind: "ssh", host: "build.internal", remoteCwd: "/srv/app" } });

    expect(paneFileDropAttributes(terminal("t1"), remote)).toMatchObject({
      "data-terminal-file-drop-location": "ssh",
    });
  });
});
