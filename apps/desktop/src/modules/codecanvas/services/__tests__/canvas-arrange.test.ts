import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { arrangeCanvasNodes, easeOutCubic, lerpPosition } from "../canvas-arrange";

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x: 0, y: 0 },
  data: {},
  ...extra,
});

/** Hero window at its default footprint, positioned in reading order via x. */
const agent = (id: string, i = 0): Node => node(id, { type: "agent", width: 720, height: 520, position: { x: i * 10, y: 0 } });
const note = (id: string, i = 0): Node => node(id, { type: "note", width: 380, height: 260, position: { x: i * 10, y: 0 } });

describe("arrangeCanvasNodes (adaptive packing)", () => {
  it("returns a box for every tiled node", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const boxes = arrangeCanvasNodes(nodes);
    expect(boxes.size).toBe(3);
    expect(boxes.get("a")).toMatchObject({ x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) });
  });

  it("gives an all-hero board a uniform cell size", () => {
    const nodes = [
      node("wide", { width: 480, height: 320 }),
      node("narrow", { width: 240, height: 180 }),
      node("tall", { width: 300, height: 400 }),
    ];
    const boxes = [...arrangeCanvasNodes(nodes).values()];
    const widths = new Set(boxes.map((b) => b.width));
    const heights = new Set(boxes.map((b) => b.height));
    expect(widths.size).toBe(1);
    expect(heights.size).toBe(1);
  });

  it("packs 4 nodes into a 2×2 grid", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const boxes = arrangeCanvasNodes(nodes);
    const xs = new Set([...boxes.values()].map((b) => b.x));
    const ys = new Set([...boxes.values()].map((b) => b.y));
    expect(xs.size).toBe(2); // 2 columns
    expect(ys.size).toBe(2); // 2 rows
  });

  it("fills the visible area edge-to-edge in fit mode (fill grid, not natural size)", () => {
    // 4 terminals at their natural 760×520 on a 1892×1018 visible area → 2×2 fill grid:
    // each cell (1892−16)/2 × (1018−16)/2 = 938×501. The grid spans the area exactly —
    // the only empty space left is the deliberate GRID_GAP.
    const nodes = Array.from({ length: 4 }, (_, i) =>
      node(`t${i}`, { width: 760, height: 520, position: { x: i * 10, y: 0 } }));
    const boxes = [...arrangeCanvasNodes(nodes, { fit: { width: 1892, height: 1018 } }).values()];
    expect(boxes[0].width).toBeCloseTo(938, 5);
    expect(boxes[0].height).toBeCloseTo(501, 5);
    const right = Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y));
    expect(right).toBeCloseTo(1892, 5);
    expect(bottom).toBeCloseTo(1018, 5);
  });

  it("packs 8 nodes into a perfect 4×2 on a wide viewport (no empty cell)", () => {
    const nodes = Array.from({ length: 8 }, (_, i) => node(`n${i}`, { position: { x: i * 10, y: 0 } }));
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 1600, height: 900 } });
    expect(boxes.size).toBe(8);
    const xs = new Set([...boxes.values()].map((b) => Math.round(b.x)));
    const ys = new Set([...boxes.values()].map((b) => Math.round(b.y)));
    expect(xs.size).toBe(4); // 4 columns
    expect(ys.size).toBe(2); // 2 rows → 4×2 fills exactly
  });

  it("stretches a short final row edge-to-edge instead of leaving a hole", () => {
    // 5 heroes on a wide viewport → 3 cols × 2 rows: the final row's 2 cells split the
    // full grid width between them — no cap, no hole (fill grid).
    const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`, { position: { x: i * 10, y: 0 } }));
    const boxes = [...arrangeCanvasNodes(nodes, { fit: { width: 1500, height: 700 } }).values()];
    const rowY = [...new Set(boxes.map((b) => Math.round(b.y)))].sort((a, b) => a - b);
    expect(rowY.length).toBe(2);
    const fullRow = boxes.filter((b) => Math.round(b.y) === rowY[0]);
    const lastRow = boxes.filter((b) => Math.round(b.y) === rowY[1]);
    expect(lastRow.length).toBeLessThan(fullRow.length);
    expect(lastRow[0].width).toBeGreaterThan(fullRow[0].width);
    // Edge-to-edge: both rows span the exact same grid width.
    const right = (b: { x: number; width: number }) => b.x + b.width;
    expect(Math.max(...lastRow.map(right))).toBeCloseTo(Math.max(...fullRow.map(right)), 5);
    expect(Math.min(...lastRow.map((b) => b.x))).toBeCloseTo(Math.min(...fullRow.map((b) => b.x)), 5);
  });

  it("pairs two consecutive small nodes into one shared cell (stacked vertically)", () => {
    const nodes = [agent("hero", 0), note("n1", 1), note("n2", 2)];
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 1600, height: 900 } });
    const hero = boxes.get("hero")!;
    const top = boxes.get("n1")!;
    const bottom = boxes.get("n2")!;
    // Pair shares one column and splits the hero cell height.
    expect(top.x).toBe(bottom.x);
    expect(top.width).toBe(bottom.width);
    expect(top.height).toBe(bottom.height);
    expect(bottom.y).toBeGreaterThan(top.y);
    expect(bottom.y + bottom.height).toBeCloseTo(hero.y + hero.height, 5);
    expect(top.height).toBeLessThan(hero.height / 2 + 1);
  });

  it("does not pair small nodes that are not consecutive in reading order", () => {
    const nodes = [note("s1", 0), agent("hero", 1), note("s2", 2)];
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 1600, height: 900 } });
    // 3 slots — each small sits in its own cell column, right-sized (shorter than the hero).
    const hero = boxes.get("hero")!;
    expect(boxes.get("s1")!.x).not.toBe(boxes.get("s2")!.x);
    expect(boxes.get("s1")!.height).toBeLessThan(hero.height);
    expect(boxes.get("s2")!.height).toBeLessThan(hero.height);
  });

  it("right-sizes a solo small node instead of inflating it to hero height", () => {
    const nodes = [agent("hero", 0), note("solo", 1)];
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 1600, height: 900 } });
    const hero = boxes.get("hero")!;
    const solo = boxes.get("solo")!;
    expect(solo.width).toBe(hero.width);
    expect(solo.height).toBeLessThan(hero.height * 0.7);
  });

  it("ignores node natural sizes in fit mode — an oversized small node cannot inflate the grid", () => {
    const nodes = [
      agent("hero", 0),
      node("giant-note", { type: "note", width: 900, height: 800, position: { x: 10, y: 0 } }),
      note("n2", 2),
    ];
    // 2 slots (hero + paired smalls) → 2 cols × 1 row: the cell is the fill division of
    // the area, (2400−16)/2 — the giant note has no say in it.
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 2400, height: 1400 } });
    expect(boxes.get("hero")!.width).toBeCloseTo((2400 - 16) / 2, 5);
  });

  it("sizes headless-fallback cells from hero nodes only (no fit supplied)", () => {
    const nodes = [
      agent("hero", 0),
      node("giant-note", { type: "note", width: 900, height: 800, position: { x: 10, y: 0 } }),
      note("n2", 2),
    ];
    const boxes = arrangeCanvasNodes(nodes);
    // Cell width comes from the 720-wide hero, not the 900-wide note.
    expect(boxes.get("hero")!.width).toBe(720);
  });

  it("reduces slot count via pairing so the camera zooms out less (3 agents + 4 smalls → 5 slots)", () => {
    const nodes = [
      agent("a1", 0), agent("a2", 1), agent("a3", 2),
      note("s1", 3), note("s2", 4), note("s3", 5), note("s4", 6),
    ];
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 1600, height: 900 } });
    expect(boxes.size).toBe(7);
    // 5 slots on a wide viewport → 3 cols × 2 slot-rows: the grid is 3 cells wide and 2 cells
    // tall, NOT the 4×2 that 7 full slots would need — that's the zoom-out saving.
    const all = [...boxes.values()];
    const minX = Math.min(...all.map((b) => b.x));
    const maxRight = Math.max(...all.map((b) => b.x + b.width));
    const cellW = boxes.get("a1")!.width;
    const cellH = boxes.get("a1")!.height;
    expect(maxRight - minX).toBeLessThanOrEqual(cellW * 3 + 32 + 1);
    const minY = Math.min(...all.map((b) => b.y));
    const maxBottom = Math.max(...all.map((b) => b.y + b.height));
    expect(maxBottom - minY).toBeLessThanOrEqual(cellH * 2 + 16 + 1);
  });

  it("still arranges a smalls-only board (cell size falls back to the smalls)", () => {
    const nodes = [note("s1", 0), note("s2", 1), note("s3", 2)];
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 1600, height: 900 } });
    expect(boxes.size).toBe(3);
    // First pair shares a column, third small is solo.
    expect(boxes.get("s1")!.x).toBe(boxes.get("s2")!.x);
    expect(boxes.get("s3")!.x).not.toBe(boxes.get("s1")!.x);
  });

  it("places nodes in reading order (top-left current node → first cell)", () => {
    const nodes = [
      node("bottom", { position: { x: 0, y: 900 } }),
      node("top", { position: { x: 0, y: 0 } }),
    ];
    const boxes = arrangeCanvasNodes(nodes);
    // 2 nodes → 2 cols, single row: the visually-higher node takes the left cell.
    expect(boxes.get("top")!.x).toBeLessThan(boxes.get("bottom")!.x);
  });

  it("leaves free-form shapes out of the grid", () => {
    const nodes = [node("note"), node("rect", { type: "shape" })];
    const boxes = arrangeCanvasNodes(nodes);
    expect(boxes.has("note")).toBe(true);
    expect(boxes.has("rect")).toBe(false);
  });

  it("clamps the uniform cell so one giant node can't dominate", () => {
    const boxes = arrangeCanvasNodes([node("huge", { width: 2000, height: 2000 }), node("b")]);
    const w = boxes.get("huge")!.width;
    expect(w).toBeLessThanOrEqual(780);
    expect(w).toBeGreaterThanOrEqual(420);
  });

  it("caps cell width at the readable aspect limit and centers the residue (super-ultrawide)", () => {
    // A solo terminal on a 32:9-class pane must not become a 3800px-wide ribbon: width is
    // capped at 2.8× the cell height and the leftover splits evenly left/right — the one
    // place a margin is allowed, because the alternative is an unreadable cell.
    const boxes = arrangeCanvasNodes([node("solo", { width: 760, height: 520, position: { x: 0, y: 0 } })], {
      fit: { width: 3800, height: 900 },
    });
    const solo = boxes.get("solo")!;
    expect(solo.width).toBeCloseTo(2.8 * 900, 5);
    expect(solo.height).toBeCloseTo(900, 5);
    expect(solo.x).toBeCloseTo((3800 - 2.8 * 900) / 2, 5);
  });

  it("never shrinks cells below the legibility floor on a cramped pane (camera zooms out instead)", () => {
    // 8 terminals on an 800×500 pane → the raw fill division (≈188×242) would be
    // unreadable; cells hold the 420×320 floor and the grid overflows the pane, which
    // the camera framing absorbs by zooming out.
    const nodes = Array.from({ length: 8 }, (_, i) => node(`n${i}`, { position: { x: i * 10, y: 0 } }));
    const boxes = [...arrangeCanvasNodes(nodes, { fit: { width: 800, height: 500 } }).values()];
    for (const b of boxes) {
      expect(b.width).toBeGreaterThanOrEqual(420);
      expect(b.height).toBeGreaterThanOrEqual(320);
    }
  });

  it("expands a single arranged node to fill the whole visible area", () => {
    const boxes = arrangeCanvasNodes([node("solo", { width: 760, height: 520 })], { fit: { width: 2400, height: 1400 } });
    expect(boxes.get("solo")!.width).toBeCloseTo(2400, 5);
    expect(boxes.get("solo")!.height).toBeCloseTo(1400, 5);
  });

  it("fills the pane even when the board is sparse (small natural sizes don't shrink the grid)", () => {
    const nodes = [node("a", { width: 300, height: 200 }), node("b", { width: 300, height: 200 })];
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 1200, height: 600 } });
    expect(boxes.get("a")!.width).toBeCloseTo((1200 - 16) / 2, 5);
    expect(boxes.get("a")!.height).toBeCloseTo(600, 5);
    expect(boxes.get("a")!.width).toBe(boxes.get("b")!.width);
  });

  it("returns empty for an empty canvas", () => {
    expect(arrangeCanvasNodes([]).size).toBe(0);
  });
});

describe("arrange animation helpers", () => {
  it("easeOutCubic is clamped and decelerating (0→0, 1→1, mid past halfway)", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-0.5)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it("lerpPosition interpolates start→target at progress k", () => {
    const s = { x: 0, y: 100 };
    const t = { x: 200, y: 300 };
    expect(lerpPosition(s, t, 0)).toEqual(s);
    expect(lerpPosition(s, t, 1)).toEqual(t);
    expect(lerpPosition(s, t, 0.5)).toEqual({ x: 100, y: 200 });
  });
});
