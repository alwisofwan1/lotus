import { describe, expect, it } from "vitest";
import {
  closeTerminalV2ActivePane,
  focusTerminalV2PaneByCycle,
  focusTerminalV2PaneByDirection,
  splitTerminalV2ActivePane,
} from "../terminal-v2-layout-controller";
import type { TerminalV2LayoutTree } from "../terminal-v2-layout-tree";

function layout(): TerminalV2LayoutTree {
  return {
    root: {
      kind: "split",
      direction: "horizontal",
      sizes: [60, 40],
      children: [
        { kind: "leaf", paneId: "left" },
        {
          kind: "split",
          direction: "vertical",
          sizes: [50, 50],
          children: [
            { kind: "leaf", paneId: "top-right" },
            { kind: "leaf", paneId: "bottom-right" },
          ],
        },
      ],
    },
    activePaneId: "left",
  };
}

function screenshotLikeLayout(): TerminalV2LayoutTree {
  return {
    root: {
      kind: "split",
      direction: "horizontal",
      sizes: [33.33, 33.33, 33.34],
      children: [
        { kind: "leaf", paneId: "left" },
        {
          kind: "split",
          direction: "vertical",
          sizes: [50, 50],
          children: [
            { kind: "leaf", paneId: "middle-top" },
            { kind: "leaf", paneId: "middle-bottom" },
          ],
        },
        {
          kind: "split",
          direction: "vertical",
          sizes: [50, 50],
          children: [
            { kind: "leaf", paneId: "right-top" },
            { kind: "leaf", paneId: "right-bottom" },
          ],
        },
      ],
    },
    activePaneId: "left",
  };
}

describe("Terminal V2 layout controller", () => {
  it("splits the active pane and focuses the newly-created pane", () => {
    const result = splitTerminalV2ActivePane({ layout: layout(), direction: "horizontal", newPaneId: "new" });

    expect(result.changed).toBe(true);
    expect(result.targetPaneId).toBe("left");
    expect(result.layout.activePaneId).toBe("new");
    expect(result.layout.root).toEqual({
      kind: "split",
      direction: "horizontal",
      sizes: [100 / 3, 100 / 3, 100 / 3],
      children: [
        { kind: "leaf", paneId: "left" },
        { kind: "leaf", paneId: "new" },
        {
          kind: "split",
          direction: "vertical",
          sizes: [50, 50],
          children: [
            { kind: "leaf", paneId: "top-right" },
            { kind: "leaf", paneId: "bottom-right" },
          ],
        },
      ],
    });
  });

  it("closes the active pane and returns which pane should be removed", () => {
    const result = closeTerminalV2ActivePane(layout());

    expect(result.changed).toBe(true);
    expect(result.closedPaneId).toBe("left");
    expect(result.layout.activePaneId).toBe("top-right");
    expect(result.layout.root).toEqual({
      kind: "split",
      direction: "vertical",
      sizes: [50, 50],
      children: [
        { kind: "leaf", paneId: "top-right" },
        { kind: "leaf", paneId: "bottom-right" },
      ],
    });
  });

  it("focuses spatially to the nearest pane in a direction", () => {
    const right = focusTerminalV2PaneByDirection(layout(), "right");
    expect(right.activePaneId).toBe("top-right");

    const down = focusTerminalV2PaneByDirection({ ...layout(), activePaneId: "top-right" }, "down");
    expect(down.activePaneId).toBe("bottom-right");
  });

  it("cycles focus by visual pane order", () => {
    expect(focusTerminalV2PaneByCycle({ ...layout(), activePaneId: "left" }, "next").activePaneId).toBe("top-right");
    expect(focusTerminalV2PaneByCycle({ ...layout(), activePaneId: "left" }, "previous").activePaneId).toBe("bottom-right");

    const screenshotLayout = screenshotLikeLayout();
    expect(focusTerminalV2PaneByCycle({ ...screenshotLayout, activePaneId: "left" }, "next").activePaneId).toBe("middle-top");
    expect(focusTerminalV2PaneByCycle({ ...screenshotLayout, activePaneId: "middle-top" }, "next").activePaneId).toBe("right-top");
    expect(focusTerminalV2PaneByCycle({ ...screenshotLayout, activePaneId: "right-top" }, "next").activePaneId).toBe("middle-bottom");
  });

  it("focuses horizontally to the nearest visually-overlapping pane in nested columns", () => {
    const current = screenshotLikeLayout();

    expect(focusTerminalV2PaneByDirection({ ...current, activePaneId: "left" }, "right").activePaneId).toBe("middle-top");
    expect(focusTerminalV2PaneByDirection({ ...current, activePaneId: "middle-top" }, "right").activePaneId).toBe("right-top");
    expect(focusTerminalV2PaneByDirection({ ...current, activePaneId: "middle-bottom" }, "right").activePaneId).toBe("right-bottom");
    expect(focusTerminalV2PaneByDirection({ ...current, activePaneId: "right-top" }, "left").activePaneId).toBe("middle-top");
  });

  it("keeps focus unchanged when there is no pane in the requested direction", () => {
    const current = layout();
    const result = focusTerminalV2PaneByDirection(current, "left");

    expect(result).toBe(current);
  });
});
