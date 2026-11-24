import { describe, expect, it } from "vitest";
import {
  closeTerminalV2LayoutPane,
  createEmptyTerminalV2Layout,
  createTerminalV2LayoutWithPane,
  focusTerminalV2LayoutPane,
  getTerminalV2LayoutPaneIds,
  resizeTerminalV2LayoutSplit,
  sanitizeTerminalV2LayoutTree,
  splitTerminalV2LayoutPane,
  swapTerminalV2LayoutPanes,
} from "../terminal-v2-layout-tree";

describe("Terminal V2 layout tree", () => {
  it("starts empty so pane creation is explicit", () => {
    const layout = createEmptyTerminalV2Layout();

    expect(layout).toEqual({ root: null, activePaneId: null });
  });

  it("creates the first pane explicitly", () => {
    const layout = createTerminalV2LayoutWithPane("pane-1");

    expect(layout.root).toEqual({ kind: "leaf", paneId: "pane-1" });
    expect(layout.activePaneId).toBe("pane-1");
    expect(getTerminalV2LayoutPaneIds(layout.root)).toEqual(["pane-1"]);
  });

  it("splits a leaf into a horizontal or vertical split and focuses the new pane", () => {
    const layout = createTerminalV2LayoutWithPane("pane-1");
    const split = splitTerminalV2LayoutPane(layout, "pane-1", "pane-2", "horizontal");

    expect(split.activePaneId).toBe("pane-2");
    expect(split.root).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        { kind: "leaf", paneId: "pane-1" },
        { kind: "leaf", paneId: "pane-2" },
      ],
      sizes: [50, 50],
    });
  });

  it("adds siblings to an existing split with the same direction instead of nesting", () => {
    const layout = createTerminalV2LayoutWithPane("pane-1");
    const split2 = splitTerminalV2LayoutPane(layout, "pane-1", "pane-2", "horizontal");
    const split3 = splitTerminalV2LayoutPane(split2, "pane-2", "pane-3", "horizontal");

    expect(split3.root).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        { kind: "leaf", paneId: "pane-1" },
        { kind: "leaf", paneId: "pane-2" },
        { kind: "leaf", paneId: "pane-3" },
      ],
      sizes: [100 / 3, 100 / 3, 100 / 3],
    });
  });

  it("closes panes, collapses single-child splits, and keeps focus nearby", () => {
    const layout = createTerminalV2LayoutWithPane("pane-1");
    const split2 = splitTerminalV2LayoutPane(layout, "pane-1", "pane-2", "horizontal");
    const split3 = splitTerminalV2LayoutPane(split2, "pane-2", "pane-3", "vertical");

    const closed = closeTerminalV2LayoutPane(split3, "pane-2");

    expect(getTerminalV2LayoutPaneIds(closed.root)).toEqual(["pane-1", "pane-3"]);
    expect(closed.activePaneId).toBe("pane-3");
  });

  it("can close the final pane back to an empty layout", () => {
    const layout = createTerminalV2LayoutWithPane("pane-1");

    expect(closeTerminalV2LayoutPane(layout, "pane-1")).toEqual({ root: null, activePaneId: null });
  });

  it("updates split sizes by split path without changing active pane", () => {
    const layout = splitTerminalV2LayoutPane(
      createTerminalV2LayoutWithPane("pane-1"),
      "pane-1",
      "pane-2",
      "horizontal",
    );

    const resized = resizeTerminalV2LayoutSplit(layout, [], [30, 70]);

    expect(resized.activePaneId).toBe("pane-2");
    expect(resized.root).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        { kind: "leaf", paneId: "pane-1" },
        { kind: "leaf", paneId: "pane-2" },
      ],
      sizes: [30, 70],
    });
  });

  it("updates nested split sizes by child path", () => {
    const layout = splitTerminalV2LayoutPane(
      splitTerminalV2LayoutPane(
        splitTerminalV2LayoutPane(createTerminalV2LayoutWithPane("pane-1"), "pane-1", "pane-2", "horizontal"),
        "pane-2",
        "pane-3",
        "vertical",
      ),
      "pane-3",
      "pane-4",
      "vertical",
    );

    const resized = resizeTerminalV2LayoutSplit(layout, [1], [25, 35, 40]);

    expect(resized.root).toEqual({
      kind: "split",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { kind: "leaf", paneId: "pane-1" },
        {
          kind: "split",
          direction: "vertical",
          sizes: [25, 35, 40],
          children: [
            { kind: "leaf", paneId: "pane-2" },
            { kind: "leaf", paneId: "pane-3" },
            { kind: "leaf", paneId: "pane-4" },
          ],
        },
      ],
    });
  });

  it("preserves valid resized split sizes when sanitizing restored metadata", () => {
    const sanitized = sanitizeTerminalV2LayoutTree({
      root: {
        kind: "split",
        direction: "horizontal",
        sizes: [30, 70],
        children: [
          { kind: "leaf", paneId: "pane-1" },
          { kind: "leaf", paneId: "pane-2" },
        ],
      },
      activePaneId: "pane-1",
    }, ["pane-1", "pane-2"]);

    expect(sanitized?.root).toEqual({
      kind: "split",
      direction: "horizontal",
      sizes: [30, 70],
      children: [
        { kind: "leaf", paneId: "pane-1" },
        { kind: "leaf", paneId: "pane-2" },
      ],
    });
  });

  it("focuses only panes that exist", () => {
    const layout = createTerminalV2LayoutWithPane("pane-1");
    const focused = focusTerminalV2LayoutPane(layout, "pane-1");
    const ignored = focusTerminalV2LayoutPane(layout, "missing");

    expect(focused.activePaneId).toBe("pane-1");
    expect(ignored).toBe(layout);
  });
});

describe("swapTerminalV2LayoutPanes", () => {
  it("trades two panes and keeps the splits and sizes", () => {
    const two = splitTerminalV2LayoutPane(createTerminalV2LayoutWithPane("a"), "a", "b", "horizontal");
    const three = splitTerminalV2LayoutPane(two, "b", "c", "vertical");
    const sized = resizeTerminalV2LayoutSplit(three, [], [30, 70]);
    const swapped = swapTerminalV2LayoutPanes(sized, "a", "c");
    expect(getTerminalV2LayoutPaneIds(swapped.root)).toEqual(["c", "b", "a"]);
    expect(swapped.root).toMatchObject({ kind: "split", sizes: (sized.root as { sizes: number[] }).sizes });
  });

  it("leaves the layout alone for a pane it does not hold", () => {
    const one = createTerminalV2LayoutWithPane("a");
    expect(swapTerminalV2LayoutPanes(one, "a", "z")).toBe(one);
  });
});
