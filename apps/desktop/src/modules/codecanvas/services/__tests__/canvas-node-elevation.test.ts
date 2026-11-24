import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { applySelectionElevation } from "../canvas-node-elevation";

const make = (spec: Array<{ id: string; type: string; selected?: boolean; zIndex?: number }>): Node[] =>
  spec.map(({ id, type, selected, zIndex }) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: {},
    ...(selected !== undefined ? { selected } : {}),
    ...(zIndex !== undefined ? { zIndex } : {}),
  }));

describe("applySelectionElevation", () => {
  it("never elevates a selected shape node — paint order stays array order (text drawn over a rectangle must not sink when the rectangle is clicked)", () => {
    const nodes = make([
      { id: "rect", type: "shape", selected: true },
      { id: "text", type: "shape" },
    ]);
    const out = applySelectionElevation(nodes, true);
    expect(out.find((n) => n.id === "rect")?.zIndex ?? 0).toBe(0);
  });

  it("elevates a selected windowed node when the setting is on", () => {
    const nodes = make([
      { id: "term", type: "terminal", selected: true },
      { id: "note", type: "note" },
    ]);
    const out = applySelectionElevation(nodes, true);
    expect(out.find((n) => n.id === "term")?.zIndex).toBe(1000);
    expect(out.find((n) => n.id === "note")?.zIndex ?? 0).toBe(0);
  });

  it("elevates nothing when the setting is off", () => {
    const nodes = make([
      { id: "term", type: "terminal", selected: true },
      { id: "rect", type: "shape", selected: true },
    ]);
    const out = applySelectionElevation(nodes, false);
    expect(out.every((n) => (n.zIndex ?? 0) === 0)).toBe(true);
  });

  it("clears a stale elevation once a node is deselected", () => {
    const nodes = make([{ id: "term", type: "terminal", selected: false, zIndex: 1000 }]);
    const out = applySelectionElevation(nodes, true);
    expect(out[0].zIndex ?? 0).toBe(0);
  });

  it("clears a stale elevation from a shape that was elevated before the policy existed", () => {
    const nodes = make([{ id: "rect", type: "shape", selected: true, zIndex: 1000 }]);
    const out = applySelectionElevation(nodes, true);
    expect(out[0].zIndex ?? 0).toBe(0);
  });

  it("keeps object identity for nodes whose elevation is already correct (drag-perf contract)", () => {
    const nodes = make([
      { id: "term", type: "terminal", selected: true, zIndex: 1000 },
      { id: "rect", type: "shape" },
    ]);
    const out = applySelectionElevation(nodes, true);
    expect(out[0]).toBe(nodes[0]);
    expect(out[1]).toBe(nodes[1]);
  });
});
