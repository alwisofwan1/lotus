import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { canonicalCanvasNodes, layoutSnapshotOf } from "../canvas-canonical-layout";

const projected = (id: string): Node => ({
  id,
  type: "agent",
  position: { x: 0, y: 0 },
  width: 1400,
  height: 900,
  measured: { width: 1400, height: 900 },
  style: { width: 1400, height: 900, color: "red" },
  className: "custom canvas-node-veiled",
  data: {},
});

describe("layoutSnapshotOf (focus snapshot, decision 41)", () => {
  it("captures Frame boxes alongside tiled nodes so exiting node focus restores the Frame too", () => {
    const nodes: Node[] = [
      { id: "F", type: "frame", position: { x: 5, y: 6 }, width: 800, height: 600, data: {} },
      { id: "a", type: "agent", position: { x: 5, y: 6 }, width: 400, height: 300, data: {} },
      { id: "s", type: "shape", position: { x: 0, y: 0 }, width: 50, height: 50, data: {} },
    ];
    const snap = layoutSnapshotOf(nodes, { w: 1, h: 1 });
    expect(snap.get("F")).toEqual({ x: 5, y: 6, width: 800, height: 600 });
    expect(snap.get("a")).toEqual({ x: 5, y: 6, width: 400, height: 300 });
    expect(snap.has("s")).toBe(false);
  });
});

describe("canonicalCanvasNodes", () => {
  it("serializes the pre-Fleet geometry without mutating the live projected nodes", () => {
    const live = [projected("agent-a")];
    const snapshot = new Map([["agent-a", { x: 10, y: 20, width: 420, height: 320 }]]);

    const canonical = canonicalCanvasNodes(live, snapshot);

    expect(canonical[0]).toMatchObject({
      position: { x: 10, y: 20 },
      width: 420,
      height: 320,
      measured: { width: 420, height: 320 },
      style: { width: 420, height: 320, color: "red" },
      className: "custom",
    });
    expect(live[0]).toMatchObject({
      position: { x: 0, y: 0 },
      width: 1400,
      height: 900,
      className: "custom canvas-node-veiled",
    });
  });
});
