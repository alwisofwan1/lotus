import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { planDiagramDraw } from "../diagram-draw-plan";

const measure = (t: string) => t.length * 8;
function ids() { let n = 0; return () => `k-${++n}`; }

const graph = {
  nodes: [{ id: "a", label: "Start", kind: "terminator" as const }, { id: "b", label: "Do", kind: "process" as const }, { id: "c", label: "OK?", kind: "decision" as const }, { id: "d", label: "End", kind: "terminator" as const }],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }],
};

function ok(r: ReturnType<typeof planDiagramDraw>) {
  if ("error" in r) throw new Error(`expected application, got ${r.error}`);
  return r;
}

describe("planDiagramDraw", () => {
  it("draws a brand-new diagram (no removals) when nothing matches", () => {
    const app = ok(planDiagramDraw({ graph, title: "Flow", nodes: [], edges: [], baseAnchor: { x: 0, y: 0 }, makeId: ids(), measure }));
    expect(app.removeIds).toEqual([]);
    expect(app.nodes.length).toBeGreaterThanOrEqual(4);
  });

  it("replaces an existing diagram in place when the graph reuses a MAJORITY of its ids", () => {
    // Existing diagram D1 with a,b,c,d + frame.
    const existing: Node[] = [
      { id: "f", type: "frame", position: { x: 50, y: 60 }, width: 400, height: 400, data: { title: "Flow", diagramId: "D1" } },
      ...["a", "b", "c", "d"].map((nid, i) => ({ id: `old-${nid}`, type: "shape", position: { x: 70, y: 80 + i * 80 }, width: 160, height: 60, data: { shape: "rectangle", diagramId: "D1", diagramNodeId: nid, text: nid, frameId: "f" } } as Node)),
    ];
    const app = ok(planDiagramDraw({ graph, title: "Flow", nodes: existing, edges: [], baseAnchor: { x: 999, y: 999 }, makeId: ids(), measure }));
    // Removes the old diagram's nodes (frame + 4 members) …
    expect(app.removeIds).toEqual(expect.arrayContaining(["f", "old-a", "old-b", "old-c", "old-d"]));
    // … forces draft so the replace is revertible …
    expect(app.draft).toBe(true);
    // … anchors at the old diagram's top-left (50,60), not the base anchor …
    const frame = app.nodes.find((n) => n.type === "frame")!;
    expect(frame.id).toBe("f");
    expect((frame.data as { title?: string }).title).toBe("Flow");
    expect(frame.position).toEqual({ x: 50, y: 60 });
    // … and every member points at the (reused) Frame id.
    for (const m of app.nodes.filter((n) => n.type === "shape")) expect((m.data as { frameId?: string }).frameId).toBe("f");
    // … reuses each unchanged node's OLD canvas id so ReactFlow glides it (not a remount) …
    const nodeIds = new Set(app.nodes.map((n) => n.id));
    for (const oldId of ["f", "old-a", "old-b", "old-c", "old-d"]) expect(nodeIds.has(oldId)).toBe(true);
    // … and matched nodes drop the stream-in class (they glide), keeping the diagram's identity.
    const matched = app.nodes.find((n) => n.id === "old-a")!;
    expect(String(matched.className ?? "")).not.toContain("canvas-shape-enter");
    expect((matched.data as { diagramId?: string }).diagramId).toBe("D1");
  });

  it("streams in a genuinely new node (fresh id) while gliding the matched ones", () => {
    const existing: Node[] = ["a", "b", "c", "d"].map((nid, i) => ({ id: `old-${nid}`, type: "shape", position: { x: 70, y: 80 + i * 80 }, width: 160, height: 60, data: { shape: "rectangle", diagramId: "D1", diagramNodeId: nid, text: nid } } as Node));
    // New graph adds "e" (End→e chain): a,b,c,d matched + e new.
    const g2 = { nodes: [...graph.nodes, { id: "e", label: "Extra", kind: "process" as const }], edges: [...graph.edges, { from: "d", to: "e" }] };
    const app = ok(planDiagramDraw({ graph: g2, title: "Flow", frame: false, nodes: existing, edges: [], baseAnchor: { x: 0, y: 0 }, makeId: ids(), measure }));
    // The new node keeps a fresh (non-old) id and streams in.
    const newNode = app.nodes.find((n) => (n.data as { diagramNodeId?: string }).diagramNodeId === "e")!;
    expect(newNode.id.startsWith("old-")).toBe(false);
    expect(String(newNode.className ?? "")).toContain("canvas-shape-enter");
  });

  it("does NOT replace an unrelated diagram that merely shares one generic id", () => {
    const existing: Node[] = ["a", "z1", "z2", "z3", "z4"].map((nid, i) => ({
      id: `s-${nid}`, type: "shape", position: { x: 0, y: i * 80 }, width: 160, height: 60,
      data: { shape: "rectangle", diagramId: "OTHER", diagramNodeId: nid, text: nid },
    } as Node));
    const app = ok(planDiagramDraw({ graph, title: "Flow", nodes: existing, edges: [] as Edge[], baseAnchor: { x: 0, y: 0 }, makeId: ids(), measure }));
    expect(app.removeIds).toEqual([]); // 1/5 overlap → treated as new, unrelated diagram untouched
  });

  it("propagates a layout error", () => {
    const r = planDiagramDraw({ graph: { nodes: [], edges: [] }, nodes: [], edges: [], baseAnchor: { x: 0, y: 0 }, makeId: ids(), measure });
    expect("error" in r && r.error).toBeTruthy();
  });
});
