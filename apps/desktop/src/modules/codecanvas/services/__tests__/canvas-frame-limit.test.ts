import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { migrateLegacyGroupsToFrames } from "../canvas-frame-migration";
import { appendFrameInBox } from "../canvas-frame-switcher";
import {
  FRAME_LIMIT_NOTICE,
  MAX_FRAMES,
  canAddFrame,
  clampFrameChanges,
  createFrameFromSelection,
  frameCreateBlock,
  frameOverlapNotice,
  tryCreateFrameFromSelection,
} from "../canvas-frames";
import type { CanvasNodeRecord } from "../../types/canvas";

const frame = (id: string, title: string, x: number, y: number, w = 300, h = 200): Node => ({
  id, type: "frame", position: { x, y }, data: { title }, width: w, height: h,
});
const agent = (id: string, x: number, y: number, frameId?: string): Node => ({
  id, type: "agent", position: { x, y }, data: frameId ? { frameId } : {}, width: 100, height: 100,
});
const frames = (n: number): Node[] => Array.from({ length: n }, (_, i) => frame(`f${i}`, `Frame ${i + 1}`, i * 2000, 5000));

describe("Frame limit (decision 33)", () => {
  it("is 4", () => {
    expect(MAX_FRAMES).toBe(4);
    expect(FRAME_LIMIT_NOTICE).toBe("Maksimal 4 Frame");
  });
  it("allows creating while under the limit and blocks at it", () => {
    expect(canAddFrame(frames(3))).toBe(true);
    expect(frameCreateBlock(frames(3))).toBeNull();
    expect(canAddFrame(frames(4))).toBe(false);
    expect(frameCreateBlock(frames(4))).toBe("Maksimal 4 Frame");
  });
  it("refuses create-from-selection at the limit and leaves the board alone", () => {
    const nodes = [...frames(4), agent("a", 0, 0), agent("b", 150, 0)];
    const r = tryCreateFrameFromSelection(nodes, ["a", "b"], "new");
    expect(r).toMatchObject({ ok: false, reason: "limit", message: "Maksimal 4 Frame" });
    expect(createFrameFromSelection(nodes, ["a", "b"], "new")).toHaveLength(nodes.length);
  });
  it("refuses the Frame tool's box at the limit", () => {
    expect(appendFrameInBox(frames(4), "new", { x: 0, y: 0, w: 200, h: 200 })).toHaveLength(4);
  });
  it("keeps every Frame of an older canvas: migration never drops one", () => {
    const records: CanvasNodeRecord[] = [];
    for (let g = 0; g < 6; g += 1) {
      for (let k = 0; k < 2; k += 1) {
        records.push({
          type: "shape", id: `s${g}-${k}`, shape: "rect", position: { x: g * 1000 + k * 150, y: 0 }, size: { w: 100, h: 100 }, groupIds: [`g${g}`],
        } as unknown as CanvasNodeRecord);
      }
    }
    const out = migrateLegacyGroupsToFrames(records);
    expect(out.filter((r) => r.type === "frame")).toHaveLength(6);
  });
});

describe("no overlap on create-from-selection (decision 34)", () => {
  it("fits around the selection when clear", () => {
    const nodes = [agent("a", 100, 100), agent("b", 250, 100)];
    expect(tryCreateFrameFromSelection(nodes, ["a", "b"], "new").ok).toBe(true);
  });
  it("shrinks padding instead of overlapping when only the padding reaches another Frame", () => {
    const nodes = [frame("o", "Other", 380, 0, 400, 600), agent("a", 100, 200), agent("b", 250, 200)];
    const r = tryCreateFrameFromSelection(nodes, ["a", "b"], "new");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const created = r.nodes.find((n) => n.id === "new")!;
      expect(created.position.x + (created.width ?? 0)).toBeLessThanOrEqual(380);
    }
  });
  it("refuses with the other Frame's name when the members sit inside it", () => {
    const nodes = [frame("o", "Auth", 0, 0, 600, 600), agent("a", 100, 100), agent("b", 250, 100)];
    expect(tryCreateFrameFromSelection(nodes, ["a", "b"], "new")).toMatchObject({
      ok: false, reason: "overlap", message: "Frame bertumpuk dengan Auth",
    });
  });
  it("frameOverlapNotice counts the title-tab strip above a drawn box", () => {
    const nodes = [frame("a", "Auth", 0, 0, 400, 300)];
    // 10px below Auth: clear of its box, but the new box's tab strip would sit on Auth
    expect(frameOverlapNotice(nodes, { x: 0, y: 310, w: 300, h: 300 })).toBe("Frame bertumpuk dengan Auth");
    expect(frameOverlapNotice(nodes, { x: 0, y: 340, w: 300, h: 300 })).toBeNull();
  });

  it("frameOverlapNotice names the Frame a drawn box lands on", () => {
    const nodes = [frame("o", "Auth", 0, 0, 300, 200)];
    expect(frameOverlapNotice(nodes, { x: 100, y: 100, w: 300, h: 300 })).toBe("Frame bertumpuk dengan Auth");
    expect(frameOverlapNotice(nodes, { x: 300, y: 0, w: 100, h: 100 })).toBeNull();
  });
});

describe("Frame drag and resize stop at another Frame (decision 34)", () => {
  const board = [frame("a", "A", 0, 0, 100, 100), frame("b", "B", 200, 0, 100, 100), agent("n", 0, 0)];
  it("clamps a dragged Frame at the neighbour's edge", () => {
    const [out] = clampFrameChanges(board, [{ id: "a", type: "position", position: { x: 180, y: 0 }, dragging: true }]);
    expect(out).toMatchObject({ position: { x: 100, y: 0 } });
  });
  it("clamps a corner resize at the neighbour's edge", () => {
    const out = clampFrameChanges(board, [{ id: "a", type: "dimensions", resizing: true, dimensions: { width: 260, height: 100 } }]);
    expect(out[0]).toMatchObject({ dimensions: { width: 200, height: 100 } });
  });
  it("never clamps a dragged node", () => {
    const change = { id: "n", type: "position", position: { x: 250, y: 10 }, dragging: true } as const;
    expect(clampFrameChanges(board, [change])[0]).toEqual(change);
  });
});
