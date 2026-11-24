import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { framesInOrder } from "../canvas-frames";
import { FRAME_TAB_STRIP } from "../canvas-frame-geometry";
import { buildFrameSwitcher } from "../canvas-frame-switcher";
import {
  fitBoundsInArea,
  frameAtPoint,
  buildFrameOverviewLabels,
  frameOverviewLabel,
  moveFrameFocus,
  overviewBounds,
  overviewDimmedNodeIds,
  overviewTitleScale,
} from "../canvas-frame-overview";

const box = (id: string, x: number, y: number, w: number, h: number): Node => ({
  id,
  type: "frame",
  position: { x, y },
  width: w,
  height: h,
  data: { title: id },
});
const member = (id: string, x: number, y: number, frameId?: string): Node => ({
  id,
  type: "note",
  position: { x, y },
  width: 100,
  height: 50,
  data: frameId ? { frameId } : {},
});

describe("overviewBounds", () => {
  it("unions every Frame and loose node, ignoring members already inside a Frame", () => {
    const nodes = [box("a", 0, 0, 400, 300), box("b", 600, 100, 400, 300), member("in", 10, 10, "a"), member("loose", -200, 500)];
    expect(overviewBounds(nodes)).toEqual({ minX: -200, minY: -FRAME_TAB_STRIP, width: 1200, height: 550 + FRAME_TAB_STRIP });
  });

  it("with no Frames fits all nodes", () => {
    expect(overviewBounds([member("x", 0, 0), member("y", 300, 200)])).toEqual({ minX: 0, minY: 0, width: 400, height: 250 });
  });

  it("is null for an empty canvas", () => {
    expect(overviewBounds([])).toBeNull();
  });
});

describe("Frame numbering", () => {
  it("Overview labels use the Switcher order (array order), never a geometric reading order", () => {
    // Array order d, b, a, c. A geometric order would call "a" first.
    const nodes = [box("d", 500, 400, 100, 100), box("b", 300, 20, 100, 100), box("a", 0, 0, 100, 100), box("c", 0, 400, 100, 100)];
    const labels = buildFrameOverviewLabels(nodes, []);
    const chips = buildFrameSwitcher(nodes, []).chips;
    for (const chip of chips) expect(labels[chip.frameId].text.split(" ")[0]).toBe(chip.label);
    expect(labels.d.text.startsWith("1 ")).toBe(true);
    expect(labels.a.text.startsWith("3 ")).toBe(true);
  });
  it("numbers past nine, where the Switcher folds chips into its overflow", () => {
    const nodes = Array.from({ length: 11 }, (_, i) => box(`f${i}`, i * 10, 0, 10, 10));
    expect(buildFrameOverviewLabels(nodes, []).f10.text.startsWith("11")).toBe(true);
  });
});

describe("Frame status in the Overview", () => {
  const nodes = [
    box("a", 0, 0, 100, 100),
    box("b", 300, 0, 100, 100),
    member("m1", 10, 10, "b"),
    member("m2", 20, 20, "b"),
    member("m3", 30, 30, "a"),
  ];
  it("shows 'needs you' on the Frame the Switcher chip flags, from the same worst-status roll-up", () => {
    const statuses = [{ id: "m1", status: "running" as const }, { id: "m2", status: "needs-you" as const }, { id: "m3", status: "idle" as const }];
    const labels = buildFrameOverviewLabels(nodes, statuses);
    expect(labels.b).toEqual({ text: "2 · needs you", needsYou: true });
    expect(labels.a).toEqual({ text: "1 · 1 node", needsYou: false });
    const chip = buildFrameSwitcher(nodes, statuses).chips.find((c) => c.frameId === "b")!;
    expect(chip.needsYou).toBe(true);
  });
});

describe("moveFrameFocus", () => {
  const frames = framesInOrder([box("a", 0, 0, 100, 100), box("b", 300, 0, 100, 100), box("c", 0, 300, 100, 100)]);
  it("starts at the first Frame when nothing is focused", () => {
    expect(moveFrameFocus(frames, null, "right")).toBe("a");
  });
  it("moves to the nearest Frame in the arrow direction", () => {
    expect(moveFrameFocus(frames, "a", "right")).toBe("b");
    expect(moveFrameFocus(frames, "a", "down")).toBe("c");
    expect(moveFrameFocus(frames, "b", "left")).toBe("a");
    expect(moveFrameFocus(frames, "c", "up")).toBe("a");
  });
  it("stays put when nothing lies that way", () => {
    expect(moveFrameFocus(frames, "a", "left")).toBe("a");
    expect(moveFrameFocus([], null, "right")).toBeNull();
  });
});

describe("overviewTitleScale", () => {
  it("counter-scales by zoom so tabs keep their on-screen size", () => {
    expect(overviewTitleScale(0.5, 0.1)).toBe(2);
  });
  it("never shrinks", () => {
    expect(overviewTitleScale(2, 0.1)).toBe(1);
  });
  it("is capped by the lowest zoom the overview can reach, so titles stay readable there (22% in the mockup)", () => {
    expect(overviewTitleScale(0.22, 0.1)).toBeCloseTo(1 / 0.22, 5);
    expect(overviewTitleScale(0.05, 0.1)).toBe(10);
  });
});

describe("frameAtPoint", () => {
  it("returns the Frame under a flow point, none outside", () => {
    const nodes = [box("a", 0, 0, 100, 100), box("b", 200, 0, 100, 100)];
    expect(frameAtPoint(nodes, { x: 250, y: 50 })).toBe("b");
    expect(frameAtPoint(nodes, { x: 150, y: 50 })).toBeNull();
  });
});

describe("labels", () => {
  it("numbers the Frame and counts members", () => {
    expect(frameOverviewLabel(0, 4)).toBe("1 · 4 nodes");
    expect(frameOverviewLabel(11, 1)).toBe("12 · 1 node");
  });
});

describe("fitBoundsInArea", () => {
  const area = { left: 100, top: 50, width: 1000, height: 500 };
  it("centres bounds in the area at the zoom that fits", () => {
    const v = fitBoundsInArea({ minX: 0, minY: 0, width: 2000, height: 500 }, area, { minZoom: 0.1, maxZoom: 1, margin: 0 });
    expect(v.zoom).toBe(0.5);
    expect(v.x).toBe(100);
    expect(v.y).toBe(50 + (500 - 250) / 2);
  });
  it("clamps to maxZoom and minZoom", () => {
    expect(fitBoundsInArea({ minX: 0, minY: 0, width: 10, height: 10 }, area, { minZoom: 0.1, maxZoom: 1, margin: 0 }).zoom).toBe(1);
    expect(fitBoundsInArea({ minX: 0, minY: 0, width: 1e6, height: 10 }, area, { minZoom: 0.1, maxZoom: 1, margin: 0 }).zoom).toBe(0.1);
  });
});

describe("overviewDimmedNodeIds (decision 44)", () => {
  const nodes: Node[] = [
    box("f1", 0, 0, 100, 100),
    { id: "a", type: "terminal", position: { x: 0, y: 0 }, data: { frameId: "f1" } },
    box("f2", 200, 0, 100, 100),
    { id: "b", type: "terminal", position: { x: 0, y: 0 }, data: { frameId: "f2" } },
    { id: "loose", type: "shape", position: { x: 0, y: 0 }, data: {} },
  ];
  it("dims every other Frame, its members and loose nodes, never the lit Frame or its members", () => {
    expect(overviewDimmedNodeIds(nodes, "f1").sort()).toEqual(["b", "f2", "loose"]);
  });
  it("dims nothing when no Frame is lit", () => {
    expect(overviewDimmedNodeIds(nodes, null)).toEqual([]);
  });
});

describe("frameOverviewLabel without the number (decision 46)", () => {
  it("drops the chip number when the auto name already says it", () => {
    expect(frameOverviewLabel(0, 3, false, false)).toBe("3 nodes");
    expect(frameOverviewLabel(1, 0, true, false)).toBe("needs you");
  });
});
