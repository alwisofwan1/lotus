import { describe, expect, it } from "vitest";
import { nextFocusedPaneId } from "@/modules/workspace-shell/services/pane-focus-move";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import type { TerminalV2LayoutTree } from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";

function cell(id: string): GridCell {
  return { id, type: "terminal", cwd: "/repo" };
}

/** Two panes side by side: `a` on the left, `b` on the right. */
function sideBySide(): TerminalV2LayoutTree {
  return {
    root: {
      kind: "split",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { kind: "leaf", paneId: "a" },
        { kind: "leaf", paneId: "b" },
      ],
    },
    activePaneId: null,
  };
}

function workspace(cells: GridCell[], patch: Partial<Workspace> = {}): Workspace {
  return { id: "ws", label: "ws", color: "#000", cwd: "/repo", rows: 1, cols: cells.length, cells, ...patch };
}

describe("nextFocusedPaneId", () => {
  it("moves to the pane that actually sits that way on screen", () => {
    const next = nextFocusedPaneId({
      workspace: workspace([cell("a"), cell("b")], {
        paneLayout: { mode: "grid", terminalV2Layout: sideBySide() },
      }),
      focusedPaneId: "a",
      command: { kind: "direction", direction: "right" },
    });

    expect(next).toBe("b");
  });

  /**
   * A workspace that has never been split has NO tree — it is `rows`, `cols` and a cell list, and
   * `WorkspaceGrid` draws it. CodeSpace never meets this shape, so this is the half of the
   * geometry the shell has to bring itself.
   *
   *   a  b
   *   c  d
   */
  it("moves down a row in a workspace that was never split", () => {
    const grid = workspace([cell("a"), cell("b"), cell("c"), cell("d")], { rows: 2, cols: 2 });

    expect(nextFocusedPaneId({ workspace: grid, focusedPaneId: "a", command: { kind: "direction", direction: "down" } }))
      .toBe("c");
    expect(nextFocusedPaneId({ workspace: grid, focusedPaneId: "a", command: { kind: "direction", direction: "right" } }))
      .toBe("b");
  });

  it("stays put at the edge rather than wrapping around", () => {
    const grid = workspace([cell("a"), cell("b"), cell("c"), cell("d")], { rows: 2, cols: 2 });

    expect(nextFocusedPaneId({ workspace: grid, focusedPaneId: "a", command: { kind: "direction", direction: "left" } }))
      .toBeNull();
    expect(nextFocusedPaneId({ workspace: grid, focusedPaneId: "a", command: { kind: "direction", direction: "up" } }))
      .toBeNull();
  });

  /**
   * ⌘1..⌘9 counts panes the way the EYE counts them — left to right, top to bottom — not the way
   * they happen to sit in the stored cell list. Splitting a pane appends the new one to that list,
   * so after two splits the stored order and the screen order have nothing to do with each other,
   * and ⌘1 would land somewhere in the middle.
   *
   * Here `c` is drawn first although it is stored last.
   */
  it("counts panes by what the eye sees, not by the stored order", () => {
    const shuffled = workspace([cell("a"), cell("b"), cell("c")], {
      paneLayout: {
        mode: "grid",
        terminalV2Layout: {
          root: {
            kind: "split",
            direction: "horizontal",
            sizes: [34, 33, 33],
            children: [
              { kind: "leaf", paneId: "c" },
              { kind: "leaf", paneId: "a" },
              { kind: "leaf", paneId: "b" },
            ],
          },
          activePaneId: null,
        },
      },
    });

    expect(nextFocusedPaneId({ workspace: shuffled, focusedPaneId: "a", command: { kind: "index", index: 0 } }))
      .toBe("c");
    expect(nextFocusedPaneId({ workspace: shuffled, focusedPaneId: "c", command: { kind: "index", index: 2 } }))
      .toBe("b");
  });

  it("does nothing when the number names no pane", () => {
    const two = workspace([cell("a"), cell("b")]);

    expect(nextFocusedPaneId({ workspace: two, focusedPaneId: "a", command: { kind: "index", index: 5 } }))
      .toBeNull();
  });

  /**
   * Cycling wraps, and directional movement does not. That difference is the point of having both:
   * ⌘⌥→ answers "what is over there", which can honestly be nothing; Ctrl+Tab answers "show me the
   * next one", which always has an answer while there is more than one pane.
   *
   *   a  b  c
   */
  it("wraps around the end when cycling", () => {
    const three = workspace([cell("a"), cell("b"), cell("c")], { rows: 1, cols: 3 });

    expect(nextFocusedPaneId({ workspace: three, focusedPaneId: "c", command: { kind: "cycle", direction: "next" } }))
      .toBe("a");
    expect(nextFocusedPaneId({ workspace: three, focusedPaneId: "a", command: { kind: "cycle", direction: "previous" } }))
      .toBe("c");
  });

  it("has nowhere to cycle to in a workspace of one pane", () => {
    const one = workspace([cell("a")]);

    expect(nextFocusedPaneId({ workspace: one, focusedPaneId: "a", command: { kind: "cycle", direction: "next" } }))
      .toBeNull();
  });

  /**
   * Focus can honestly be nowhere — a workspace just opened, or the pane that had it was closed and
   * the id left behind. A key pressed then must still land somewhere, because "nothing happens"
   * reads as a broken shortcut and the way out is the mouse.
   */
  it.each([
    ["nothing focused", null],
    ["a pane that has since been closed", "gone"],
  ])("still lands on a real pane with %s", (_label, focusedPaneId) => {
    const two = workspace([cell("a"), cell("b")], { rows: 1, cols: 2 });

    expect(nextFocusedPaneId({ workspace: two, focusedPaneId, command: { kind: "cycle", direction: "next" } }))
      .toBe("a");
    expect(nextFocusedPaneId({ workspace: two, focusedPaneId, command: { kind: "index", index: 1 } }))
      .toBe("b");
  });

  it.each([
    ["no workspace at all", null],
    ["a workspace with no panes", workspace([])],
  ])("does nothing with %s", (_label, ws) => {
    expect(nextFocusedPaneId({ workspace: ws, focusedPaneId: null, command: { kind: "direction", direction: "right" } }))
      .toBeNull();
  });
});
