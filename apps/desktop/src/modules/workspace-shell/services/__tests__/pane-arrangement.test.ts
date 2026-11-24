import { describe, expect, it } from "vitest";
import {
  balancedPaneLayout,
  gridShape,
  isBalanced,
  paneBoxInLayout,
  rowSplit,
  splitDirectionForPane,
} from "../pane-arrangement";
import { resolveTrackSizes } from "@/modules/workspace-shell/services/grid-layout";
import { SPLIT_HANDLE_SIZE } from "@/modules/workspace-shell/services/split-sizing";
import type { TerminalV2LayoutNode } from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";

const ids = (count: number) => Array.from({ length: count }, (_, index) => `p${index + 1}`);

/** A compact shape string: `h(a,b)` / `v(x,y)`, so a whole tree fits in one assertion. */
function shape(node: TerminalV2LayoutNode | null): string {
  if (!node) return "-";
  if (node.kind === "leaf") return node.paneId;
  const mark = node.direction === "horizontal" ? "h" : "v";
  return `${mark}(${node.children.map(shape).join(",")})`;
}

describe("gridShape", () => {
  it("stays as square as it gets, and never taller than wide", () => {
    expect(gridShape(1)).toEqual({ rows: 1, cols: 1 });
    expect(gridShape(2)).toEqual({ rows: 1, cols: 2 });
    expect(gridShape(4)).toEqual({ rows: 2, cols: 2 });
    expect(gridShape(6)).toEqual({ rows: 2, cols: 3 });
    expect(gridShape(9)).toEqual({ rows: 3, cols: 3 });
  });

  it("puts the remainder in the earlier rows, so the short row is the bottom one", () => {
    expect(rowSplit(3)).toEqual([2, 1]);
    expect(rowSplit(5)).toEqual([3, 2]);
    expect(rowSplit(7)).toEqual([3, 2, 2]);
  });
});

describe("balancedPaneLayout", () => {
  it("keeps one pane a leaf and two panes a single row — no wrapper that cannot be dragged", () => {
    expect(shape(balancedPaneLayout(ids(1), null).root)).toBe("p1");
    expect(shape(balancedPaneLayout(ids(2), null).root)).toBe("h(p1,p2)");
  });

  it("nests rows once a flat row would be too narrow to use", () => {
    // This is the whole bug: five panes used to be five columns.
    expect(shape(balancedPaneLayout(ids(5), null).root)).toBe("v(h(p1,p2,p3),h(p4,p5))");
    expect(shape(balancedPaneLayout(ids(4), null).root)).toBe("v(h(p1,p2),h(p3,p4))");
    expect(shape(balancedPaneLayout(ids(3), null).root)).toBe("v(h(p1,p2),p3)");
  });

  /**
   * The seam guard, and it earned its place: built with `sizes: []` this layout rendered fine and
   * had no draggable seams anywhere, because `SplitTree` only draws a handle when
   * `resolveTrackSizes` returns one track per child — and that returns `[]` for an empty list.
   * Reported from the native window as "resize stops working past four panes".
   */
  it("gives every split one size per child, which is what makes a seam draggable", () => {
    for (const count of [2, 3, 4, 5, 7, 9]) {
      const root = balancedPaneLayout(ids(count), null).root!;
      const splits: Extract<TerminalV2LayoutNode, { kind: "split" }>[] = [];
      const walk = (node: TerminalV2LayoutNode) => {
        if (node.kind !== "split") return;
        splits.push(node);
        node.children.forEach(walk);
      };
      walk(root);

      for (const split of splits) {
        expect(split.sizes, `${count} panes`).toHaveLength(split.children.length);
        expect(split.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(100);
        // The exact condition SplitTree calls `measured`, and gates its handles on.
        expect(resolveTrackSizes(1000, split.sizes, SPLIT_HANDLE_SIZE, 180)).toHaveLength(
          split.children.length,
        );
      }
    }
  });

  it("keeps the active pane when it is still there, and picks one when it is not", () => {
    expect(balancedPaneLayout(ids(3), "p2").activePaneId).toBe("p2");
    expect(balancedPaneLayout(ids(3), "gone").activePaneId).toBe("p1");
    expect(balancedPaneLayout([], null).root).toBeNull();
  });

  it("drops duplicates rather than drawing a pane twice", () => {
    expect(shape(balancedPaneLayout(["a", "a", "b"], null).root)).toBe("h(a,b)");
  });
});

describe("paneBoxInLayout", () => {
  const tree = balancedPaneLayout(ids(4), null).root;

  it("gives each pane its real share of the box", () => {
    expect(paneBoxInLayout(tree, "p1", { width: 1000, height: 800 })).toEqual({ width: 500, height: 400 });
  });

  it("follows the sizes a seam was dragged to", () => {
    const dragged: TerminalV2LayoutNode = {
      kind: "split",
      direction: "horizontal",
      children: [{ kind: "leaf", paneId: "a" }, { kind: "leaf", paneId: "b" }],
      sizes: [0.75, 0.25],
    };
    expect(paneBoxInLayout(dragged, "b", { width: 1000, height: 500 })).toEqual({ width: 250, height: 500 });
  });

  it("returns nothing for a pane the tree does not hold", () => {
    expect(paneBoxInLayout(tree, "nope", { width: 100, height: 100 })).toBeNull();
  });
});

describe("splitDirectionForPane", () => {
  it("splits the longer axis, which is what stops a workspace drifting into columns", () => {
    const one = balancedPaneLayout(["a"], null).root;
    // A wide window: the first split makes two tall panes…
    expect(splitDirectionForPane(one, "a", { width: 1400, height: 800 })).toBe("horizontal");

    // …and splitting one of THOSE stacks, because it is now taller than it is wide.
    const two = balancedPaneLayout(["a", "b"], null).root;
    expect(splitDirectionForPane(two, "a", { width: 1400, height: 800 })).toBe("vertical");
  });

  it("falls back to the whole box when the pane is not in the tree yet", () => {
    expect(splitDirectionForPane(null, "a", { width: 1400, height: 800 })).toBe("horizontal");
    expect(splitDirectionForPane(null, null, { width: 400, height: 900 })).toBe("vertical");
  });

  it("answers horizontally when it has not been measured, rather than throwing", () => {
    expect(splitDirectionForPane(null, null, { width: 0, height: 0 })).toBe("horizontal");
  });
});

describe("isBalanced", () => {
  it("knows when tidying would change nothing", () => {
    const tidy = balancedPaneLayout(ids(4), "p1");
    expect(isBalanced(tidy, ids(4))).toBe(true);

    const flat = {
      root: {
        kind: "split" as const,
        direction: "horizontal" as const,
        children: ids(4).map((paneId) => ({ kind: "leaf" as const, paneId })),
        sizes: [],
      },
      activePaneId: "p1",
    };
    expect(isBalanced(flat, ids(4))).toBe(false);
  });
});
