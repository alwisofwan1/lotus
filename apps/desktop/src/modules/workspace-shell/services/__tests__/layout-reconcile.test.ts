import { describe, expect, it } from "vitest";
import {
  createTerminalV2LayoutFromPaneIds,
  getTerminalV2LayoutPaneIds,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import { reconcileLayoutWithPanes } from "@/modules/workspace-shell/services/layout-reconcile";

describe("reconcileLayoutWithPanes", () => {
  it("adopts a pane that was created outside the layout", () => {
    // `addPane` — used by the add-pane menu, by tasks and by MCP spawns — appends to the cells
    // and never touches the split tree. A pane the tree does not know is a pane nobody can see.
    const tree = createTerminalV2LayoutFromPaneIds(["a", "b"], "a");
    const next = reconcileLayoutWithPanes(tree, ["a", "b", "c"]);

    expect(getTerminalV2LayoutPaneIds(next.root)).toEqual(["a", "b", "c"]);
  });
});

describe("reconcileLayoutWithPanes — keeping what is still true", () => {
  it("leaves a tree alone when it already matches, so sizes survive", () => {
    const tree = createTerminalV2LayoutFromPaneIds(["a", "b"], "a");
    expect(reconcileLayoutWithPanes(tree, ["a", "b"])).toBe(tree);
  });

  it("drops a pane that no longer exists", () => {
    const tree = createTerminalV2LayoutFromPaneIds(["a", "b", "c"], "b");
    expect(getTerminalV2LayoutPaneIds(reconcileLayoutWithPanes(tree, ["a", "c"]).root)).toEqual(["a", "c"]);
  });

  it("keeps the active pane when it survived, and picks one when it did not", () => {
    const tree = createTerminalV2LayoutFromPaneIds(["a", "b"], "b");
    expect(reconcileLayoutWithPanes(tree, ["a", "b", "c"]).activePaneId).toBe("b");
    expect(reconcileLayoutWithPanes(tree, ["c", "d"]).activePaneId).toBe("c");
  });

  it("builds a tree from nothing for a workspace that never had one", () => {
    expect(getTerminalV2LayoutPaneIds(reconcileLayoutWithPanes(null, ["a"]).root)).toEqual(["a"]);
  });
});

describe("the shape a rebuild lands in", () => {
  it("is a grid, not one long row", () => {
    const tree = reconcileLayoutWithPanes(null, ["a", "b", "c", "d"]);
    const root = tree.root!;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    // Two rows of two. As one horizontal split of four it was four columns, which is what a
    // fifth terminal made unusable.
    expect(root.direction).toBe("vertical");
    expect(root.children).toHaveLength(2);
    expect(root.children.every((child) => child.kind === "split" && child.children.length === 2)).toBe(true);
  });
});
