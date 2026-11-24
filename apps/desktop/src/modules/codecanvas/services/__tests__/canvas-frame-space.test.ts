import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { FRAME_TAB_STRIP } from "../canvas-frame-geometry";
import {
  boxesOverlap,
  clampFrameMove,
  clampFrameResize,
  fitBoxAvoidingFrames,
  frameChromeVisible,
  FRAME_CHROME_ZOOM,
  placeFrameInFreeSpace,
} from "../canvas-frame-space";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const frame = (id: string, x: number, y: number, w: number, h: number): Node => ({
  id, type: "frame", position: { x, y }, data: { title: id }, width: w, height: h,
});

describe("boxesOverlap", () => {
  it("is false for boxes that only touch", () => {
    expect(boxesOverlap(box(0, 0, 100, 100), box(100, 0, 100, 100))).toBe(false);
  });
  it("is true for a real intersection", () => {
    expect(boxesOverlap(box(0, 0, 100, 100), box(99, 50, 100, 100))).toBe(true);
  });
});

describe("frameChromeVisible", () => {
  it("is hidden at and above the zoom threshold, shown below", () => {
    expect(FRAME_CHROME_ZOOM).toBe(0.4);
    expect(frameChromeVisible({ zoom: 0.4 })).toBe(false);
    expect(frameChromeVisible({ zoom: 1 })).toBe(false);
    expect(frameChromeVisible({ zoom: 0.39 })).toBe(true);
  });
  it("is shown at any zoom in the overview, as a drop target, while renaming or with a menu open", () => {
    expect(frameChromeVisible({ zoom: 1, overview: true })).toBe(true);
    expect(frameChromeVisible({ zoom: 1, dropTarget: true })).toBe(true);
    expect(frameChromeVisible({ zoom: 1, editing: true })).toBe(true);
    expect(frameChromeVisible({ zoom: 1, menuOpen: true })).toBe(true);
  });
});

describe("placeFrameInFreeSpace", () => {
  const size = { w: 200, h: 100 };
  it("centres on the wanted point when it is free", () => {
    expect(placeFrameInFreeSpace([], size, { x: 500, y: 300 })).toEqual({ x: 400, y: 250 });
  });
  it("never overlaps an existing Frame and lands near the centre", () => {
    const frames = [frame("a", 300, 200, 400, 300)];
    const pos = placeFrameInFreeSpace(frames, size, { x: 500, y: 350 });
    expect(boxesOverlap({ ...pos, ...size }, box(300, 200, 400, 300))).toBe(false);
    expect(Math.hypot(pos.x + 100 - 500, pos.y + 50 - 350)).toBeLessThan(400);
  });
  it("avoids every Frame when several crowd the centre", () => {
    const frames = [frame("a", 0, 0, 400, 300), frame("b", 420, 0, 400, 300), frame("c", 0, 320, 400, 300), frame("d", 420, 320, 400, 300)];
    const pos = placeFrameInFreeSpace(frames, size, { x: 410, y: 310 });
    for (const f of frames) expect(boxesOverlap({ ...pos, ...size }, box(f.position.x, f.position.y, 400, 300))).toBe(false);
  });
});

describe("title-tab strip (decision 35)", () => {
  it("a Frame placed under another leaves room for its own tab strip", () => {
    const pos = placeFrameInFreeSpace([frame("a", 0, 0, 400, 300)], { w: 400, h: 300 }, { x: 200, y: 460 });
    // 160px centre drop would put the box 10px under "a": too close for the tab
    expect(boxesOverlap(box(pos.x, pos.y - FRAME_TAB_STRIP, 400, 300 + FRAME_TAB_STRIP), box(0, -FRAME_TAB_STRIP, 400, 300 + FRAME_TAB_STRIP))).toBe(false);
  });
});

describe("fitBoxAvoidingFrames", () => {
  const members = [box(100, 100, 100, 100)];
  it("hugs the members (padding 0) when nothing is near", () => {
    const r = fitBoxAvoidingFrames(members, []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.box).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });
  it("reserves the neighbour's title-tab strip: a Frame right below it must leave room for the tab", () => {
    const other = frame("o", 100, 0, 100, 100 - FRAME_TAB_STRIP + 10); // ends 10px into the strip above the members
    expect(fitBoxAvoidingFrames(members, [other])).toEqual({ ok: false, overlapWith: "o" });
    const clear = frame("c", 100, 0, 100, 100 - FRAME_TAB_STRIP);
    expect(fitBoxAvoidingFrames(members, [clear]).ok).toBe(true);
  });
  it("refuses, naming the Frame, when the members themselves overlap it", () => {
    const other = frame("Auth", 150, 0, 400, 400);
    expect(fitBoxAvoidingFrames(members, [other])).toEqual({ ok: false, overlapWith: "Auth" });
  });
});

describe("clampFrameMove", () => {
  const moving = box(0, 0, 100, 100);
  const other = box(200, 0, 100, 100);
  it("passes a free move through", () => {
    expect(clampFrameMove(moving, { x: 50, y: 40 }, [other])).toEqual({ x: 50, y: 40 });
  });
  it("stops at the edge of another Frame when dragged into it", () => {
    expect(clampFrameMove(moving, { x: 180, y: 0 }, [other])).toEqual({ x: 100, y: 0 });
  });
  it("slides along the edge: the free axis keeps moving", () => {
    expect(clampFrameMove(moving, { x: 180, y: 60 }, [other])).toEqual({ x: 100, y: 60 });
  });
  it("stops going left and vertically too", () => {
    expect(clampFrameMove(box(400, 0, 100, 100), { x: 250, y: 0 }, [other])).toEqual({ x: 300, y: 0 });
    // the tab strip above the lower Frame stops it FRAME_TAB_STRIP short of the other's bottom edge
    expect(clampFrameMove(box(200, 200, 100, 100), { x: 200, y: 50 }, [other])).toEqual({ x: 200, y: 100 + FRAME_TAB_STRIP });
  });
  it("leaves an already-overlapping legacy Frame free to move", () => {
    expect(clampFrameMove(box(150, 0, 100, 100), { x: 160, y: 0 }, [other])).toEqual({ x: 160, y: 0 });
  });
});

describe("clampFrameResize", () => {
  const prev = box(0, 0, 100, 100);
  const other = box(200, 0, 100, 100);
  it("passes a free resize through", () => {
    expect(clampFrameResize(prev, box(0, 0, 150, 120), [other])).toEqual(box(0, 0, 150, 120));
  });
  it("stops the right edge at another Frame", () => {
    expect(clampFrameResize(prev, box(0, 0, 260, 100), [other])).toEqual(box(0, 0, 200, 100));
  });
  it("stops the left edge of a Frame resized from its left side", () => {
    expect(clampFrameResize(box(400, 0, 100, 100), box(250, 0, 250, 100), [other])).toEqual(box(300, 0, 200, 100));
  });
  it("stops the top edge", () => {
    expect(clampFrameResize(box(200, 200, 100, 100), box(200, 50, 100, 250), [other])).toEqual(box(200, 100 + FRAME_TAB_STRIP, 100, 200 - FRAME_TAB_STRIP));
  });
});
