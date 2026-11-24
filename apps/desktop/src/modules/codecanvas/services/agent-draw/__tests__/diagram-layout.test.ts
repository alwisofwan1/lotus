import { describe, expect, it } from "vitest";
import { layoutDiagram, type DiagramGraph, type DiagramLayoutOptions } from "../diagram-layout";

// Deterministic measurer: 8px per character. Keeps layout assertions pure (no canvas/DOM).
const measure = (text: string) => text.length * 8;

function opts(overrides: Partial<DiagramLayoutOptions> = {}): DiagramLayoutOptions {
  let seq = 0;
  return {
    anchor: { x: 500, y: 300 },
    measure,
    makeId: () => `n-${++seq}`,
    ...overrides,
  };
}

const LOGIN: DiagramGraph = {
  nodes: [
    { id: "start", kind: "terminator", label: "Start" },
    { id: "login", kind: "process", label: "Login form" },
    { id: "valid", kind: "decision", label: "Credentials valid?" },
    { id: "dash", kind: "process", label: "Dashboard" },
    { id: "err", kind: "process", label: "Show error" },
  ],
  edges: [
    { from: "start", to: "login" },
    { from: "login", to: "valid", label: "submit" },
    { from: "valid", to: "dash", label: "yes" },
    { from: "valid", to: "err", label: "no" },
  ],
};

describe("layoutDiagram — structure", () => {
  it("produces one positioned shape per node and one connector per edge", () => {
    const out = layoutDiagram(LOGIN, opts());
    expect(out.shapes).toHaveLength(5);
    expect(out.connectors).toHaveLength(4);
    expect(out.rejected).toEqual([]);
  });

  it("maps diagram kinds to canvas shape kinds", () => {
    const out = layoutDiagram(LOGIN, opts());
    const byLabel = (label: string) => out.shapes.find((s) => s.spec.text === label)!.spec.shape;
    expect(byLabel("Start")).toBe("ellipse");
    expect(byLabel("Login form")).toBe("rectangle");
    expect(byLabel("Credentials valid?")).toBe("diamond");
  });

  it("defaults an unknown/absent kind to a rectangle", () => {
    const out = layoutDiagram(
      { nodes: [{ id: "x", label: "mystery" }], edges: [] },
      opts(),
    );
    expect(out.shapes[0].spec.shape).toBe("rectangle");
  });

  it("connectors reference the minted canvas shape ids, not the diagram node ids", () => {
    const out = layoutDiagram(LOGIN, opts());
    const ids = new Set(out.shapes.map((s) => s.id));
    for (const c of out.connectors) {
      expect(ids.has(c.source)).toBe(true);
      expect(ids.has(c.target)).toBe(true);
    }
    const submit = out.connectors.find((c) => c.label === "submit")!;
    const login = out.shapes.find((s) => s.spec.text === "Login form")!;
    const valid = out.shapes.find((s) => s.spec.text === "Credentials valid?")!;
    expect(submit.source).toBe(login.id);
    expect(submit.target).toBe(valid.id);
  });

  it("sizes a shape to its label width via the injected measurer", () => {
    const out = layoutDiagram(
      { nodes: [{ id: "a", kind: "process", label: "x" }, { id: "b", kind: "process", label: "a very long label indeed" }], edges: [] },
      opts(),
    );
    const short = out.shapes.find((s) => s.spec.text === "x")!;
    const long = out.shapes.find((s) => s.spec.text!.startsWith("a very"))!;
    expect(long.spec.size.w).toBeGreaterThan(short.spec.size.w);
  });
});

describe("layoutDiagram — direction", () => {
  it("TB stacks a successor below its predecessor", () => {
    const g: DiagramGraph = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] };
    const out = layoutDiagram(g, opts({ direction: "TB" }));
    const a = out.shapes.find((s) => s.spec.text === "A")!;
    const b = out.shapes.find((s) => s.spec.text === "B")!;
    expect(b.spec.position.y).toBeGreaterThan(a.spec.position.y);
  });

  it("LR places a successor to the right of its predecessor", () => {
    const g: DiagramGraph = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] };
    const out = layoutDiagram(g, opts({ direction: "LR" }));
    const a = out.shapes.find((s) => s.spec.text === "A")!;
    const b = out.shapes.find((s) => s.spec.text === "B")!;
    expect(b.spec.position.x).toBeGreaterThan(a.spec.position.x);
  });
});

describe("layoutDiagram — anchor & bounds", () => {
  it("translates the whole diagram so its top-left sits at the anchor", () => {
    const out = layoutDiagram(LOGIN, opts({ anchor: { x: 1000, y: 2000 }, frame: false }));
    const minX = Math.min(...out.shapes.map((s) => s.spec.position.x));
    const minY = Math.min(...out.shapes.map((s) => s.spec.position.y));
    expect(minX).toBe(1000);
    expect(minY).toBe(2000);
  });

  it("reports a bounds box that contains every shape", () => {
    const out = layoutDiagram(LOGIN, opts());
    for (const s of out.shapes) {
      expect(s.spec.position.x).toBeGreaterThanOrEqual(out.bounds.x);
      expect(s.spec.position.y).toBeGreaterThanOrEqual(out.bounds.y);
      expect(s.spec.position.x + s.spec.size.w).toBeLessThanOrEqual(out.bounds.x + out.bounds.w + 0.01);
      expect(s.spec.position.y + s.spec.size.h).toBeLessThanOrEqual(out.bounds.y + out.bounds.h + 0.01);
    }
  });

  it("rounds coordinates to integers", () => {
    const out = layoutDiagram(LOGIN, opts());
    for (const s of out.shapes) {
      expect(Number.isInteger(s.spec.position.x)).toBe(true);
      expect(Number.isInteger(s.spec.position.y)).toBe(true);
    }
  });
});

describe("layoutDiagram — auto-frame", () => {
  it("wraps the diagram in a frame rectangle with the title as its area label", () => {
    const out = layoutDiagram(LOGIN, opts({ frame: { title: "Login flow" } }));
    expect(out.frame).not.toBeNull();
    expect(out.frame!.spec.shape).toBe("rectangle");
    expect(out.frame!.spec.areaLabel).toBe("Login flow");
  });

  it("the frame hugs every shape (padding 0)", () => {
    const out = layoutDiagram(LOGIN, opts({ anchor: { x: 100, y: 100 }, frame: { title: "Login flow" } }));
    const f = out.frame!;
    const shapeMinX = Math.min(...out.shapes.map((s) => s.spec.position.x));
    const shapeMinY = Math.min(...out.shapes.map((s) => s.spec.position.y));
    const shapeMaxX = Math.max(...out.shapes.map((s) => s.spec.position.x + s.spec.size.w));
    const shapeMaxY = Math.max(...out.shapes.map((s) => s.spec.position.y + s.spec.size.h));
    expect(f.spec.position).toEqual({ x: shapeMinX, y: shapeMinY });
    expect(Math.abs(f.spec.position.x + f.spec.size.w - shapeMaxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.spec.position.y + f.spec.size.h - shapeMaxY)).toBeLessThanOrEqual(1);
  });

  it("places the frame's top-left at the anchor and starts the contents at the same corner", () => {
    const out = layoutDiagram(LOGIN, opts({ anchor: { x: 100, y: 100 }, frame: { title: "Login flow" } }));
    expect(out.frame!.spec.position).toEqual({ x: 100, y: 100 });
    const minX = Math.min(...out.shapes.map((s) => s.spec.position.x));
    expect(minX).toBe(100);
  });

  it("omits the frame when frame is false", () => {
    const out = layoutDiagram(LOGIN, opts({ frame: false }));
    expect(out.frame).toBeNull();
  });

  it("shares a group id between the frame and all member shapes (drag-frame-moves-group)", () => {
    const out = layoutDiagram(LOGIN, opts({ frame: { title: "Login flow" } }));
    const gid = out.groupId;
    expect(gid).toBeTruthy();
    expect(out.frame!.spec.groupIds).toContain(gid);
    for (const s of out.shapes) expect(s.spec.groupIds).toContain(gid);
  });
});

describe("layoutDiagram — validation", () => {
  it("returns an error for an empty graph", () => {
    const out = layoutDiagram({ nodes: [], edges: [] }, opts());
    expect(out.error).toBeTruthy();
    expect(out.shapes).toEqual([]);
  });

  it("drops duplicate node ids and reports them", () => {
    const g: DiagramGraph = { nodes: [{ id: "a", label: "A" }, { id: "a", label: "A2" }], edges: [] };
    const out = layoutDiagram(g, opts());
    expect(out.shapes).toHaveLength(1);
    expect(out.rejected.some((r) => /duplicate/i.test(r.reason))).toBe(true);
  });

  it("drops edges referencing unknown nodes and reports them", () => {
    const g: DiagramGraph = { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] };
    const out = layoutDiagram(g, opts());
    expect(out.connectors).toEqual([]);
    expect(out.rejected.some((r) => /ghost/.test(r.reason))).toBe(true);
  });

  it("caps the node count to protect against runaway graphs", () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    const out = layoutDiagram({ nodes, edges: [] }, opts());
    expect(out.error).toBeTruthy();
  });
});
