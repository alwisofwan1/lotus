import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { focusCanvasLayout, shouldEnterFocusFromDoubleClick } from "../canvas-focus-layout";

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x: 0, y: 0 },
  data: {},
  ...extra,
});

const FIT = { width: 1332, height: 748 };

describe("focusCanvasLayout (rail kanan)", () => {
  it("gives the hero the visible area minus the right rail", () => {
    const nodes = [node("hero"), node("b", { position: { x: 100, y: 0 } })];
    const boxes = focusCanvasLayout(nodes, "hero", { fit: FIT });
    const hero = boxes.get("hero")!;
    const thumb = boxes.get("b")!;
    expect(hero.height).toBe(FIT.height);
    expect(hero.width + 16 + thumb.width).toBeCloseTo(FIT.width, 5);
    expect(hero.width).toBeGreaterThan(FIT.width * 0.7);
  });

  it("keeps the rail wide enough for its thumbnails to read", () => {
    // Wide canvas → rail clamps to its max band, comfortably readable (not a sliver).
    const wide = focusCanvasLayout([node("hero"), node("b", { position: { x: 1, y: 0 } })], "hero", {
      fit: { width: 2400, height: 900 },
    });
    expect(wide.get("b")!.width).toBeGreaterThanOrEqual(360);
  });

  it("stacks the other nodes down the rail in reading order", () => {
    const nodes = [
      node("hero", { position: { x: 0, y: 0 } }),
      node("below", { position: { x: 0, y: 500 } }),
      node("above", { position: { x: 10, y: 10 } }),
    ];
    const boxes = focusCanvasLayout(nodes, "hero", { fit: FIT });
    const above = boxes.get("above")!;
    const below = boxes.get("below")!;
    expect(above.x).toBe(below.x);
    expect(above.y).toBeLessThan(below.y);
    expect(above.x).toBeGreaterThan(boxes.get("hero")!.width - 1);
  });

  it("fills the rail height so a lone companion bottom-aligns with the hero", () => {
    const two = focusCanvasLayout([node("hero"), node("b", { position: { x: 1, y: 0 } })], "hero", { fit: FIT });
    const b = two.get("b")!;
    const hero = two.get("hero")!;
    expect(b.height).toBeCloseTo(FIT.height, 5);
    expect(b.y + b.height).toBeCloseTo(hero.y + hero.height, 5);
  });

  it("evenly divides the full height across several thumbnails with no dead space", () => {
    const nodes = [
      node("hero"),
      node("a", { position: { x: 1, y: 0 } }),
      node("b", { position: { x: 1, y: 100 } }),
      node("c", { position: { x: 1, y: 200 } }),
    ];
    const boxes = focusCanvasLayout(nodes, "hero", { fit: FIT });
    const heights = ["a", "b", "c"].map((id) => boxes.get(id)!.height);
    // Equal thumbnails whose stack (cards + inner gaps) spans the whole visible height.
    expect(heights[0]).toBeCloseTo(heights[1], 5);
    expect(heights[1]).toBeCloseTo(heights[2], 5);
    const stack = heights.reduce((sum, h) => sum + h, 0) + (heights.length - 1) * 16;
    expect(stack).toBeCloseTo(FIT.height, 5);
    const last = boxes.get("c")!;
    expect(last.y + last.height).toBeCloseTo(boxes.get("hero")!.height, 5);
  });

  it("floors thumbnails at a readable minimum when the rail is crowded", () => {
    const many = [node("hero"), ...Array.from({ length: 15 }, (_, i) => node(`t${i}`, { position: { x: i + 1, y: 0 } }))];
    const boxes = focusCanvasLayout(many, "hero", { fit: FIT });
    expect(boxes.get("t0")!.height).toBe(72);
  });

  it("lets a solo hero take the whole visible area", () => {
    const boxes = focusCanvasLayout([node("hero")], "hero", { fit: FIT });
    expect(boxes.get("hero")).toMatchObject({ width: FIT.width, height: FIT.height });
  });

  it("anchors the layout at the cluster's current top-left", () => {
    const nodes = [
      node("hero", { position: { x: 1000, y: 2000 } }),
      node("b", { position: { x: 1400, y: 2100 } }),
    ];
    const boxes = focusCanvasLayout(nodes, "hero", { fit: FIT });
    expect(boxes.get("hero")).toMatchObject({ x: 1000, y: 2000 });
  });

  it("skips free-form shapes and returns empty for an unknown or shape hero", () => {
    const nodes = [node("hero"), node("rect", { type: "shape", position: { x: 5, y: 5 } })];
    const boxes = focusCanvasLayout(nodes, "hero", { fit: FIT });
    expect(boxes.has("rect")).toBe(false);
    expect(focusCanvasLayout(nodes, "rect", { fit: FIT }).size).toBe(0);
    expect(focusCanvasLayout(nodes, "missing", { fit: FIT }).size).toBe(0);
  });
});

describe("shouldEnterFocusFromDoubleClick", () => {
  function nodeDom(inner: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = `<div class="canvas-node">${inner}</div>`;
    return host;
  }

  it("accepts a plain double-click on the node header chrome", () => {
    const host = nodeDom('<div class="canvas-node-header"><span class="label">rowan</span></div>');
    expect(shouldEnterFocusFromDoubleClick(host.querySelector(".label"))).toBe(true);
  });

  it("rejects the body (xterm/editor surfaces own double-click there)", () => {
    const host = nodeDom('<div class="canvas-node-body"><span class="x">term</span></div>');
    expect(shouldEnterFocusFromDoubleClick(host.querySelector(".x"))).toBe(false);
  });

  it("rejects the agent rename name span (double-click starts rename)", () => {
    const host = nodeDom('<div class="canvas-node-header"><span class="canvas-persona-name">rowan</span></div>');
    expect(shouldEnterFocusFromDoubleClick(host.querySelector(".canvas-persona-name"))).toBe(false);
  });

  it("rejects buttons, inputs, and contenteditable regions", () => {
    const host = nodeDom(
      '<div class="canvas-node-header"><button class="b">×</button><input class="i" />' +
      '<div contenteditable="true"><span class="e">txt</span></div></div>',
    );
    expect(shouldEnterFocusFromDoubleClick(host.querySelector(".b"))).toBe(false);
    expect(shouldEnterFocusFromDoubleClick(host.querySelector(".i"))).toBe(false);
    expect(shouldEnterFocusFromDoubleClick(host.querySelector(".e"))).toBe(false);
  });

  it("rejects non-element targets", () => {
    expect(shouldEnterFocusFromDoubleClick(null)).toBe(false);
  });
});
