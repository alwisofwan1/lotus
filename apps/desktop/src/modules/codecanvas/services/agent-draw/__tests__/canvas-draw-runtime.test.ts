import { describe, expect, it } from "vitest";
import { buildDrawApplication, STREAM_CLASS, streamEnterDelayMs, STREAM_MAX_DELAY_MS, staggerDiagramAnchor, DIAGRAM_STAGGER_STEP, DIAGRAM_STAGGER_WRAP, type DrawRuntimeContext } from "../canvas-draw-runtime";
import type { DiagramGraph } from "../diagram-layout";

const enterDelay = (styled: { style?: unknown }) =>
  parseInt(String((styled.style as Record<string, unknown> | undefined)?.["--canvas-enter-delay"] ?? "0"), 10);

function ctx(overrides: Partial<DrawRuntimeContext> = {}): DrawRuntimeContext {
  let seq = 0;
  return {
    anchor: { x: 1000, y: 2000 },
    existingShapeIds: new Set<string>(),
    makeId: () => `k-${++seq}`,
    measure: (t: string) => t.length * 8,
    ...overrides,
  };
}

function app(result: ReturnType<typeof buildDrawApplication>) {
  if ("error" in result) throw new Error(`expected application, got error: ${result.error}`);
  return result;
}

describe("buildDrawApplication — ops mode", () => {
  it("turns create ops into shape nodes and connector ops into canvas-wire edges", () => {
    const out = app(buildDrawApplication(
      {
        mode: "ops",
        ops: [
          { op: "create_shape", shape: "rectangle", ref: "$a", text: "A", at: [0, 0] },
          { op: "create_shape", shape: "diamond", ref: "$b", text: "B?", at: [0, 200] },
          { op: "create_connector", from: "$a", to: "$b", label: "yes" },
        ],
      },
      ctx(),
    ));
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes.every((n) => n.type === "shape")).toBe(true);
    expect(out.edges).toHaveLength(1);
    const edge = out.edges[0];
    expect(edge.type).toBe("canvas-wire");
    expect((edge.data as { wireKind?: string }).wireKind).toBe("connector");
    expect(edge.source).toBe(out.nodes[0].id);
    expect(edge.target).toBe(out.nodes[1].id);
    expect(edge.markerEnd).toBeTruthy();
    // Regression (ReactFlow #008): every connector must bind to real ShapeNode handle ids, or
    // the edge is dropped and no arrow renders.
    expect(edge.sourceHandle).toBe("wire-bottom");
    expect(edge.targetHandle).toBe("wire-top");
  });

  it("binds diagram connectors to direction-appropriate handles (LR → right/left)", () => {
    const graph = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] };
    const out = app(buildDrawApplication({ mode: "diagram", graph, direction: "LR", frame: false }, ctx()));
    expect(out.edges[0].sourceHandle).toBe("wire-right");
    expect(out.edges[0].targetHandle).toBe("wire-left");
  });

  it("routes update ops to patches and delete ops to removeIds", () => {
    const out = app(buildDrawApplication(
      {
        mode: "ops",
        ops: [
          { op: "update_shape", id: "s1", patch: { text: "renamed" } },
          { op: "delete_shape", id: "s2" },
        ],
      },
      ctx({ existingShapeIds: new Set(["s1", "s2"]) }),
    ));
    expect(out.nodes).toEqual([]);
    expect(out.patches).toEqual([{ id: "s1", patch: { text: "renamed" } }]);
    expect(out.removeIds).toEqual(["s2"]);
  });

  it("surfaces per-op rejections in the receipt without failing the batch", () => {
    const out = app(buildDrawApplication(
      { mode: "ops", ops: [{ op: "create_shape", shape: "image" }, { op: "create_shape", shape: "text", text: "ok" }] },
      ctx(),
    ));
    expect(out.nodes).toHaveLength(1);
    expect(out.receipt.rejected).toHaveLength(1);
  });

  it("returns a batch-level error for an unsafe payload", () => {
    const result = buildDrawApplication({ mode: "ops", ops: "not-an-array" }, ctx());
    expect("error" in result && result.error).toBeTruthy();
  });
});

describe("buildDrawApplication — draft policy", () => {
  const bigOps = Array.from({ length: 5 }, (_, i) => ({ op: "create_shape", shape: "rectangle", text: `n${i}` }));

  it("defaults to draft when more than 3 elements are created", () => {
    const out = app(buildDrawApplication({ mode: "ops", ops: bigOps }, ctx()));
    expect(out.draft).toBe(true);
    expect(out.nodes.every((n) => (n.data as { agentDraft?: boolean }).agentDraft === true)).toBe(true);
  });

  it("defaults to non-draft for a small (≤3) batch", () => {
    const out = app(buildDrawApplication(
      { mode: "ops", ops: [{ op: "create_shape", shape: "rectangle", text: "one" }] },
      ctx(),
    ));
    expect(out.draft).toBe(false);
    expect((out.nodes[0].data as { agentDraft?: boolean }).agentDraft).toBeUndefined();
  });

  it("honours an explicit draft override", () => {
    const out = app(buildDrawApplication(
      { mode: "ops", draft: true, ops: [{ op: "create_shape", shape: "rectangle", text: "one" }] },
      ctx(),
    ));
    expect(out.draft).toBe(true);
    expect((out.nodes[0].data as { agentDraft?: boolean }).agentDraft).toBe(true);
  });

  it("records a ledger batch id covering every created node and edge", () => {
    const out = app(buildDrawApplication({ mode: "ops", ops: bigOps }, ctx()));
    expect(out.batchId).toBeTruthy();
    expect(out.createdIds).toEqual(out.nodes.map((n) => n.id));
  });
});

describe("buildDrawApplication — diagram mode", () => {
  const graph: DiagramGraph = {
    nodes: [
      { id: "s", kind: "terminator", label: "Start" },
      { id: "p", kind: "process", label: "Do thing" },
      { id: "d", kind: "decision", label: "OK?" },
    ],
    edges: [
      { from: "s", to: "p" },
      { from: "p", to: "d", label: "next" },
    ],
  };

  it("emits a real Frame node titled by the diagram label plus one shape per graph node", () => {
    const out = app(buildDrawApplication({ mode: "diagram", graph, frame: { title: "Flow" } }, ctx()));
    expect(out.nodes).toHaveLength(4);
    expect(out.edges).toHaveLength(2);
    const frames = out.nodes.filter((n) => n.type === "frame");
    expect(frames).toHaveLength(1);
    expect((frames[0].data as { title?: string }).title).toBe("Flow");
    expect(out.nodes.filter((n) => n.type === "shape")).toHaveLength(3);
    expect(out.edges.every((e) => (e.data as { wireKind?: string }).wireKind === "connector")).toBe(true);
  });

  it("paints the Frame behind its members (Frame is first in node order)", () => {
    const out = app(buildDrawApplication({ mode: "diagram", graph, frame: { title: "Flow" } }, ctx()));
    expect(out.nodes[0].type).toBe("frame");
  });

  it("points every member shape at the Frame via frameId and uses no legacy group ids or diagramFrame rect", () => {
    const out = app(buildDrawApplication({ mode: "diagram", graph, frame: { title: "Flow" } }, ctx()));
    const frame = out.nodes[0];
    for (const n of out.nodes.slice(1)) {
      const d = n.data as { frameId?: string; groupIds?: string[] };
      expect(d.frameId).toBe(frame.id);
      expect(d.groupIds).toBeUndefined();
    }
    expect(out.nodes.some((n) => (n.data as { diagramFrame?: boolean }).diagramFrame)).toBe(false);
    expect(frame.width ?? 0).toBeGreaterThan(0);
  });

  it("omits the frame when frame is false", () => {
    const out = app(buildDrawApplication({ mode: "diagram", graph, frame: false }, ctx()));
    expect(out.nodes).toHaveLength(3);
    expect(out.nodes.some((n) => n.type === "frame")).toBe(false);
  });

  it("stamps a shared diagramId and per-shape diagramNodeId so a later edit can re-match nodes", () => {
    const out = app(buildDrawApplication({ mode: "diagram", graph, frame: { title: "Flow" } }, ctx()));
    const ids = out.nodes.map((n) => (n.data as { diagramId?: string }).diagramId);
    expect(new Set(ids).size).toBe(1); // the Frame keeps the diagramId too
    expect(ids[0]).toBeTruthy();
    const semantic = out.nodes.map((n) => (n.data as { diagramNodeId?: string }).diagramNodeId).filter(Boolean).sort();
    expect(semantic).toEqual(["d", "p", "s"]);
  });

  it("propagates a diagram layout error", () => {
    const result = buildDrawApplication({ mode: "diagram", graph: { nodes: [], edges: [] } }, ctx());
    expect("error" in result && result.error).toBeTruthy();
  });
});

describe("buildDrawApplication — streaming draw-in", () => {
  const graph: DiagramGraph = {
    nodes: [{ id: "s", kind: "terminator", label: "Start" }, { id: "p", kind: "process", label: "Do" }, { id: "e", kind: "terminator", label: "End" }],
    edges: [{ from: "s", to: "p" }, { from: "p", to: "e" }],
  };

  it("marks every drawn node/edge with the stream class and an increasing enter delay", () => {
    const out = app(buildDrawApplication({ mode: "diagram", graph, frame: { title: "F" } }, ctx()));
    for (const n of out.nodes) expect(String(n.className)).toContain(STREAM_CLASS);
    for (const e of out.edges) expect(String(e.className)).toContain(STREAM_CLASS);
    // Frame enters first (delay 0); each subsequent shape is later.
    const delays = out.nodes.map(enterDelay);
    expect(delays[0]).toBe(0);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
  });

  it("streams connectors AFTER all shapes (later enter delay than any node)", () => {
    const out = app(buildDrawApplication({ mode: "diagram", graph, frame: false }, ctx()));
    const maxNode = Math.max(...out.nodes.map(enterDelay));
    for (const e of out.edges) expect(enterDelay(e)).toBeGreaterThan(maxNode);
  });

  it("clamps the enter delay so a huge diagram still finishes promptly", () => {
    expect(streamEnterDelayMs(9999)).toBe(STREAM_MAX_DELAY_MS);
    expect(streamEnterDelayMs(0)).toBe(0);
  });
});

describe("staggerDiagramAnchor", () => {
  const base = { x: 100, y: 200 };
  it("returns the base for the first diagram", () => {
    expect(staggerDiagramAnchor(base, 0)).toEqual(base);
  });
  it("nudges each subsequent diagram diagonally so they don't stack exactly", () => {
    expect(staggerDiagramAnchor(base, 1)).toEqual({ x: 100 + DIAGRAM_STAGGER_STEP, y: 200 + DIAGRAM_STAGGER_STEP });
    expect(staggerDiagramAnchor(base, 2)).toEqual({ x: 100 + 2 * DIAGRAM_STAGGER_STEP, y: 200 + 2 * DIAGRAM_STAGGER_STEP });
  });
  it("wraps back to base so it never marches off-screen", () => {
    expect(staggerDiagramAnchor(base, DIAGRAM_STAGGER_WRAP)).toEqual(base);
  });
  it("is safe for negative indices", () => {
    const r = staggerDiagramAnchor(base, -1);
    expect(Number.isFinite(r.x)).toBe(true);
    expect(r.x).toBeGreaterThanOrEqual(base.x);
  });
});

describe("buildDrawApplication — mode guard", () => {
  it("rejects an unknown mode", () => {
    const result = buildDrawApplication({ mode: "sculpt" } as never, ctx());
    expect("error" in result && result.error).toMatch(/mode/i);
  });
});
