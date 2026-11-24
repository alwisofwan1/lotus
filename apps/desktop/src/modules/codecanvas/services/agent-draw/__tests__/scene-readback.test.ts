import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { buildSceneReadback } from "../scene-readback";

const shape = (id: string, x: number, y: number, data: Record<string, unknown> = {}): Node => ({
  id, type: "shape", position: { x, y }, width: 160, height: 60,
  data: { shape: "rectangle", ...data },
});
const connector = (id: string, source: string, target: string, label?: string): Edge => ({
  id, source, target, type: "canvas-wire",
  data: { wireKind: "connector", ...(label ? { customLabel: label } : {}) },
});

describe("buildSceneReadback", () => {
  it("returns shape nodes with id, kind, bounds, and text", () => {
    const scene = buildSceneReadback(
      [shape("a", 100, 200, { shape: "diamond", text: "Valid?" })],
      [],
      {},
    );
    expect(scene.shapes).toHaveLength(1);
    expect(scene.shapes[0]).toMatchObject({
      id: "a", shape: "diamond", text: "Valid?",
      bounds: { x: 100, y: 200, w: 160, h: 60 },
    });
  });

  it("includes connectors between shapes with their labels", () => {
    const scene = buildSceneReadback(
      [shape("a", 0, 0), shape("b", 0, 200)],
      [connector("e1", "a", "b", "yes")],
      {},
    );
    expect(scene.connectors).toEqual([{ source: "a", target: "b", label: "yes" }]);
  });

  it("reads a connector label from the edge's plain label when no customLabel is set", () => {
    const scene = buildSceneReadback(
      [shape("a", 0, 0), shape("b", 0, 200)],
      [{ id: "e1", source: "a", target: "b", type: "canvas-wire", label: "no", data: { wireKind: "connector" } }],
      {},
    );
    expect(scene.connectors[0].label).toBe("no");
  });

  it("ignores edges whose endpoints are not both shapes", () => {
    const scene = buildSceneReadback(
      [shape("a", 0, 0)],
      [connector("e1", "a", "term-1")],
      {},
    );
    expect(scene.connectors).toEqual([]);
  });

  it("counts non-shape nodes separately so the agent knows other content exists", () => {
    const scene = buildSceneReadback(
      [shape("a", 0, 0), { id: "t1", type: "terminal", position: { x: 0, y: 0 }, data: {} }],
      [],
      {},
    );
    expect(scene.counts).toMatchObject({ shapes: 1, otherNodes: 1 });
  });

  it("falls back to measured/style size when width/height are absent", () => {
    const n: Node = { id: "a", type: "shape", position: { x: 10, y: 10 }, data: { shape: "ellipse" }, measured: { width: 120, height: 44 } };
    const scene = buildSceneReadback([n], [], {});
    expect(scene.shapes[0].bounds).toEqual({ x: 10, y: 10, w: 120, h: 44 });
  });

  describe("viewport tiering", () => {
    const nodes = [
      shape("in", 100, 100, { text: "visible" }),
      shape("out", 5000, 5000, { text: "far away" }),
    ];
    const viewport = { x: 0, y: 0, w: 1000, h: 800 };

    it("details shapes intersecting the viewport and clusters the rest", () => {
      const scene = buildSceneReadback(nodes, [], { viewport });
      expect(scene.shapes.map((s) => s.id)).toEqual(["in"]);
      expect(scene.clusters).toHaveLength(1);
      expect(scene.clusters[0].count).toBe(1);
      expect(scene.clusters[0].bounds.x).toBeGreaterThan(1000);
    });

    it("with no off-viewport shapes, produces no clusters", () => {
      const scene = buildSceneReadback([shape("in", 100, 100)], [], { viewport });
      expect(scene.clusters).toEqual([]);
    });

    it("counts.connectors reports ALL shape-to-shape edges (not just detailed), consistent with counts.shapes", () => {
      // Two shapes both far off-viewport (clustered, not detailed) with an edge between them.
      const far = [shape("x", 5000, 5000), shape("y", 5200, 5000)];
      const scene = buildSceneReadback(far, [connector("e", "x", "y")], { viewport });
      expect(scene.connectors).toEqual([]); // neither endpoint detailed → not in the detailed list
      expect(scene.counts.connectors).toBe(1); // …but the total count still reflects it
    });
  });

  it("caps detailed shapes and clusters the overflow", () => {
    const many = Array.from({ length: 10 }, (_, i) => shape(`s${i}`, i * 10, 0));
    const scene = buildSceneReadback(many, [], { maxDetailed: 4 });
    expect(scene.shapes).toHaveLength(4);
    expect(scene.clusters).toHaveLength(1);
    expect(scene.clusters[0].count).toBe(6);
    expect(scene.counts.shapes).toBe(10);
  });
});

describe("buildSceneReadback — Frames (LOT2-126)", () => {
  const frame = (id: string, title: string, x: number, y: number, data: Record<string, unknown> = {}): Node => ({
    id, type: "frame", position: { x, y }, width: 600, height: 400, data: { title, ...data },
  });
  const terminal = (id: string, frameId?: string): Node => ({
    id, type: "terminal", position: { x: 10, y: 10 }, width: 300, height: 200, data: frameId ? { frameId } : {},
  });

  it("lists Frames with id, title, colorId, box and members of every kind", () => {
    const scene = buildSceneReadback(
      [frame("f1", "Auth", 0, 0, { colorId: "blue" }), shape("s1", 20, 20, { frameId: "f1" }), terminal("t1", "f1"), terminal("t2")],
      [],
      {},
    );
    expect(scene.frames).toEqual([
      {
        id: "f1", title: "Auth", colorId: "blue", bounds: { x: 0, y: 0, w: 600, h: 400 },
        members: [{ id: "s1", type: "shape" }, { id: "t1", type: "terminal" }],
      },
    ]);
  });

  it("stamps frameId on a framed shape and leaves loose shapes without one", () => {
    const scene = buildSceneReadback([frame("f1", "A", 0, 0), shape("in", 1, 1, { frameId: "f1" }), shape("out", 900, 900)], [], {});
    expect(scene.shapes.find((s) => s.id === "in")?.frameId).toBe("f1");
    expect(scene.shapes.find((s) => s.id === "out")).not.toHaveProperty("frameId");
  });

  it("counts Frames separately and keeps them out of otherNodes", () => {
    const scene = buildSceneReadback([frame("f1", "A", 0, 0), terminal("t1")], [], {});
    expect(scene.counts).toMatchObject({ frames: 1, otherNodes: 1 });
  });

  it("returns an empty frames list when the board has none", () => {
    expect(buildSceneReadback([shape("a", 0, 0)], [], {}).frames).toEqual([]);
  });
});

