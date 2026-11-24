import { describe, expect, it } from "vitest";
import { applyShapeStylePatch, linearShapeFromDrag, normalizeFreehand, normalizeShapeFields, shapeRectFromDrag, textBoxSize, textToolEditTarget, cycleSelectBehind } from "../canvas-shape";

describe("textBoxSize", () => {
  it("fits the box to the widest line + padding and lines × line-height", () => {
    const measure = (s: string) => s.length * 10; // 10px per char
    const r = textBoxSize("ab\ncdef", 20, { measure, lineHeight: 1.5, padX: 12, padY: 8 });
    expect(r.w).toBe(64); // widest "cdef"=40 + 2*12
    expect(r.h).toBe(76); // 2 lines * 20 * 1.5 + 2*8
  });

  it("never collapses to zero for empty text", () => {
    const r = textBoxSize("", 20, { measure: () => 0, padX: 12, padY: 8, minW: 24 });
    expect(r.w).toBeGreaterThanOrEqual(24);
    expect(r.h).toBeGreaterThan(0);
  });

  it("grows height with each newline", () => {
    const measure = () => 30;
    const one = textBoxSize("a", 20, { measure });
    const three = textBoxSize("a\nb\nc", 20, { measure });
    expect(three.h).toBeGreaterThan(one.h);
  });
});

describe("normalizeFreehand", () => {
  it("fits a freehand stroke to its bbox and normalizes the points 0..1", () => {
    expect(normalizeFreehand([{ x: 10, y: 10 }, { x: 60, y: 30 }, { x: 110, y: 10 }])).toEqual({
      position: { x: 10, y: 10 },
      size: { w: 100, h: 20 },
      points: [[0, 0], [0.5, 1], [1, 0]],
    });
  });

  it("floors a flat/degenerate stroke to a minimum box without NaNs", () => {
    const r = normalizeFreehand([{ x: 5, y: 5 }, { x: 5, y: 5 }]);
    expect(r.size.w).toBeGreaterThanOrEqual(1);
    expect(r.size.h).toBeGreaterThanOrEqual(1);
    expect(r.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
});

describe("applyShapeStylePatch", () => {
  it("merges a style delta into the target's own style, preserving untouched fields", () => {
    expect(applyShapeStylePatch({ strokeColor: "#fff", opacity: 50 }, { style: { strokeColor: "#000" } }))
      .toEqual({ style: { strokeColor: "#000", opacity: 50 } });
  });

  it("removes fields the delta explicitly clears (e.g. transparent background)", () => {
    expect(applyShapeStylePatch({ fill: "#111", fillStyle: "hachure" }, { style: { fill: undefined, fillStyle: undefined } }))
      .toEqual({ style: {} });
  });

  it("passes non-style patches (text/areaLabel) straight through", () => {
    expect(applyShapeStylePatch({ strokeColor: "#fff" }, { text: "hi" })).toEqual({ text: "hi" });
  });
});

describe("linearShapeFromDrag", () => {
  it("returns bounds + normalized endpoints for a main-diagonal drag", () => {
    expect(linearShapeFromDrag({ x: 10, y: 10 }, { x: 110, y: 70 })).toEqual({
      position: { x: 10, y: 10 },
      size: { w: 100, h: 60 },
      points: [[0, 0], [1, 1]],
    });
  });

  it("preserves direction for an anti-diagonal drag", () => {
    expect(linearShapeFromDrag({ x: 110, y: 10 }, { x: 10, y: 70 })).toEqual({
      position: { x: 10, y: 10 },
      size: { w: 100, h: 60 },
      points: [[1, 0], [0, 1]],
    });
  });

  it("handles a horizontal drag with a minimum box height", () => {
    expect(linearShapeFromDrag({ x: 10, y: 50 }, { x: 110, y: 50 })).toEqual({
      position: { x: 10, y: 50 },
      size: { w: 100, h: 2 },
      points: [[0, 0], [1, 0]],
    });
  });
});

describe("shapeRectFromDrag", () => {
  const def = { w: 200, h: 140 };

  it("returns the dragged bounds (top-left + size) for a real drag", () => {
    expect(shapeRectFromDrag({ x: 10, y: 10 }, { x: 110, y: 70 }, def)).toEqual({
      position: { x: 10, y: 10 },
      size: { w: 100, h: 60 },
    });
  });

  it("normalizes a reversed drag to a positive rect", () => {
    expect(shapeRectFromDrag({ x: 110, y: 70 }, { x: 10, y: 10 }, def)).toEqual({
      position: { x: 10, y: 10 },
      size: { w: 100, h: 60 },
    });
  });

  it("treats a negligible drag (a click) as a default-sized shape at the point", () => {
    expect(shapeRectFromDrag({ x: 10, y: 10 }, { x: 12, y: 11 }, def)).toEqual({
      position: { x: 10, y: 10 },
      size: { w: 200, h: 140 },
    });
  });
});

describe("normalizeShapeFields", () => {
  it("keeps a valid shape kind and defaults invalid/missing ones to rectangle", () => {
    expect(normalizeShapeFields({ shape: "ellipse" }).shape).toBe("ellipse");
    expect(normalizeShapeFields({ shape: "nope" }).shape).toBe("rectangle");
    expect(normalizeShapeFields({}).shape).toBe("rectangle");
  });

  it("preserves linear shapes (arrow/line) across a reload instead of collapsing to rectangle", () => {
    expect(normalizeShapeFields({ shape: "arrow" }).shape).toBe("arrow");
    expect(normalizeShapeFields({ shape: "line" }).shape).toBe("line");
  });

  it("preserves freehand draw shapes across a reload", () => {
    expect(normalizeShapeFields({ shape: "draw", points: [[0, 0], [0.5, 1], [1, 0]] }).shape).toBe("draw");
  });

  it("preserves an image shape and its durable asset URI + intrinsic dimensions", () => {
    const fields = normalizeShapeFields({
      shape: "image",
      imageAssetUri: "lotus-note-asset://asset_abc",
      imageAlt: "screenshot",
      imageNaturalWidth: 1600,
      imageNaturalHeight: 900,
    });
    expect(fields.shape).toBe("image");
    expect(fields).toMatchObject({
      imageAssetUri: "lotus-note-asset://asset_abc",
      imageAlt: "screenshot",
      imageNaturalWidth: 1600,
      imageNaturalHeight: 900,
    });
  });

  it("extracts text and areaLabel only when they are strings", () => {
    expect(normalizeShapeFields({ shape: "text", text: "hi", areaLabel: "flow" })).toMatchObject({ text: "hi", areaLabel: "flow" });
    expect(normalizeShapeFields({ shape: "rectangle", text: 5 }).text).toBeUndefined();
  });

  it("validates style fields and drops junk/out-of-range values", () => {
    const s = normalizeShapeFields({
      shape: "rectangle",
      style: { strokeColor: "#fff", strokeWidth: 2, strokeStyle: "dashed", sloppiness: "artist", opacity: 80, fill: "#eee", junk: 1 },
    }).style;
    expect(s).toEqual({ strokeColor: "#fff", strokeWidth: 2, strokeStyle: "dashed", sloppiness: "artist", opacity: 80, fill: "#eee" });
    expect(normalizeShapeFields({ shape: "rectangle", style: { strokeStyle: "zigzag", opacity: 999 } }).style).toEqual({});
  });

  it("clamps oversized persisted stroke widths and drops non-positive widths", () => {
    expect(normalizeShapeFields({ shape: "rectangle", style: { strokeWidth: 999 } }).style).toEqual({ strokeWidth: 12 });
    expect(normalizeShapeFields({ shape: "rectangle", style: { strokeWidth: 0 } }).style).toEqual({});
  });

  it("omits style entirely when absent", () => {
    expect(normalizeShapeFields({ shape: "rectangle" }).style).toBeUndefined();
  });

  it("validates fillStyle against the rough.js allow-list and drops junk", () => {
    expect(normalizeShapeFields({ shape: "rectangle", style: { fillStyle: "hachure" } }).style).toEqual({ fillStyle: "hachure" });
    expect(normalizeShapeFields({ shape: "rectangle", style: { fillStyle: "cross-hatch" } }).style).toEqual({ fillStyle: "cross-hatch" });
    expect(normalizeShapeFields({ shape: "rectangle", style: { fillStyle: "zigzag" } }).style).toEqual({});
  });

  it("validates arrow fields (arrowType/startArrowhead/endArrowhead) and drops junk", () => {
    expect(normalizeShapeFields({ shape: "arrow", style: { arrowType: "elbow", startArrowhead: "dot", endArrowhead: "triangle" } }).style)
      .toEqual({ arrowType: "elbow", startArrowhead: "dot", endArrowhead: "triangle" });
    expect(normalizeShapeFields({ shape: "arrow", style: { arrowType: "zigzag", startArrowhead: "star", endArrowhead: "blob" } }).style)
      .toEqual({});
  });

  it("validates text style fields (fontFamily/fontSize/textAlign) and drops junk", () => {
    expect(normalizeShapeFields({ shape: "text", style: { fontFamily: "heading", fontSize: "L", textAlign: "right" } }).style)
      .toEqual({ fontFamily: "heading", fontSize: "L", textAlign: "right" });
    expect(normalizeShapeFields({ shape: "text", style: { fontFamily: "comic", fontSize: "XXL", textAlign: "justify" } }).style)
      .toEqual({});
  });

  it("validates fontScale (positive finite, clamped) and drops junk", () => {
    expect(normalizeShapeFields({ shape: "text", style: { fontScale: 1.5 } }).style).toEqual({ fontScale: 1.5 });
    expect(normalizeShapeFields({ shape: "text", style: { fontScale: 0 } }).style).toEqual({});
    expect(normalizeShapeFields({ shape: "text", style: { fontScale: -2 } }).style).toEqual({});
    expect(normalizeShapeFields({ shape: "text", style: { fontScale: Infinity } }).style).toEqual({});
  });

  it("validates verticalAlign and drops junk", () => {
    expect(normalizeShapeFields({ shape: "text", style: { verticalAlign: "top" } }).style).toEqual({ verticalAlign: "top" });
    expect(normalizeShapeFields({ shape: "rectangle", style: { verticalAlign: "justify" } }).style).toEqual({});
  });

  it("migrates the legacy 'serif' font family to 'heading' on load", () => {
    expect(normalizeShapeFields({ shape: "text", style: { fontFamily: "serif" } }).style)
      .toEqual({ fontFamily: "heading" });
  });
});

describe("textToolEditTarget", () => {
  const shape = (id: string, kind: string, x: number, y: number, w: number, h: number) => ({
    id, type: "shape", position: { x, y }, width: w, height: h, data: { shape: kind },
  });

  it("targets the container under the click so the text tool edits its bound text instead of stacking a loose text node", () => {
    const nodes = [shape("rect", "rectangle", 0, 0, 200, 100)];
    expect(textToolEditTarget({ x: 50, y: 50 }, nodes)).toBe("rect");
  });

  it("targets an existing text element under the click (Excalidraw: text tool edits existing text)", () => {
    const nodes = [shape("txt", "text", 10, 10, 80, 30)];
    expect(textToolEditTarget({ x: 20, y: 20 }, nodes)).toBe("txt");
  });

  it("returns null on empty canvas — the caller places a new standalone text there", () => {
    expect(textToolEditTarget({ x: 500, y: 500 }, [shape("rect", "rectangle", 0, 0, 200, 100)])).toBeNull();
  });

  it("picks the topmost editable shape when several overlap (last in array paints on top)", () => {
    const nodes = [
      shape("below", "rectangle", 0, 0, 200, 100),
      shape("above", "ellipse", 0, 0, 200, 100),
    ];
    expect(textToolEditTarget({ x: 50, y: 50 }, nodes)).toBe("above");
  });

  it("ignores path and image shapes — they hold no editable text", () => {
    const nodes = [
      shape("arrow", "arrow", 0, 0, 200, 100),
      shape("img", "image", 0, 0, 200, 100),
    ];
    expect(textToolEditTarget({ x: 50, y: 50 }, nodes)).toBeNull();
  });

  it("ignores non-shape nodes (terminals, notes) — the text tool never types into workflow nodes", () => {
    const nodes = [{ id: "term", type: "terminal", position: { x: 0, y: 0 }, width: 400, height: 300, data: {} }];
    expect(textToolEditTarget({ x: 50, y: 50 }, nodes)).toBeNull();
  });

  it("ignores unmeasured shapes (no width/height yet)", () => {
    const nodes = [{ id: "rect", type: "shape", position: { x: 0, y: 0 }, data: { shape: "rectangle" } }];
    expect(textToolEditTarget({ x: 0, y: 0 }, nodes)).toBeNull();
  });
});

describe("cycleSelectBehind", () => {
  // hits arrive in paint order: bottom → top
  it("selects the topmost shape when nothing relevant is selected", () => {
    expect(cycleSelectBehind(["bottom", "mid", "top"], null)).toBe("top");
    expect(cycleSelectBehind(["bottom", "mid", "top"], "elsewhere")).toBe("top");
  });

  it("steps one shape deeper below the current selection on each call", () => {
    expect(cycleSelectBehind(["bottom", "mid", "top"], "top")).toBe("mid");
    expect(cycleSelectBehind(["bottom", "mid", "top"], "mid")).toBe("bottom");
  });

  it("wraps back to the topmost after the bottom", () => {
    expect(cycleSelectBehind(["bottom", "mid", "top"], "bottom")).toBe("top");
  });

  it("returns null when nothing is under the pointer", () => {
    expect(cycleSelectBehind([], null)).toBeNull();
  });
});

describe("normalizeShapeFields — angle", () => {
  it("keeps a finite angle, wrapped into [0, 360)", () => {
    expect(normalizeShapeFields({ shape: "rectangle", angle: 45 }).angle).toBe(45);
    expect(normalizeShapeFields({ shape: "rectangle", angle: -30 }).angle).toBe(330);
    expect(normalizeShapeFields({ shape: "rectangle", angle: 405 }).angle).toBe(45);
  });

  it("drops zero, missing, and invalid angles (0 is the absent default)", () => {
    expect(normalizeShapeFields({ shape: "rectangle", angle: 0 }).angle).toBeUndefined();
    expect(normalizeShapeFields({ shape: "rectangle" }).angle).toBeUndefined();
    expect(normalizeShapeFields({ shape: "rectangle", angle: "45" }).angle).toBeUndefined();
    expect(normalizeShapeFields({ shape: "rectangle", angle: Infinity }).angle).toBeUndefined();
  });
});
