import { describe, expect, it } from "vitest";
import { decodeCanvasSnapshot } from "../canvas-snapshot-codec";
import type { CanvasFrameNodeRecord, CanvasNodeRecord } from "../../types/canvas";

type Raw = Record<string, unknown>;

const shape = (id: string, x: number, y: number, extra: Raw = {}): Raw => ({
  type: "shape", id, position: { x, y }, size: { w: 100, h: 50 }, shape: "rectangle", ...extra,
});
const note = (id: string, x: number, y: number): Raw => ({
  type: "note", id, position: { x, y }, size: { w: 200, h: 100 }, content: "",
});

function load(nodes: Raw[]): CanvasNodeRecord[] {
  const result = decodeCanvasSnapshot({ schemaVersion: 1, id: "c", rootDir: "/r", nodes, edges: [] });
  if (!result.ok) throw new Error(result.error);
  return result.snapshot.nodes;
}
const frames = (nodes: CanvasNodeRecord[]) => nodes.filter((n): n is CanvasFrameNodeRecord => n.type === "frame");
const byId = (nodes: CanvasNodeRecord[], id: string) => nodes.find((n) => n.id === id)!;

describe("old canvases without groups", () => {
  it("load unchanged: no Frame appears", () => {
    const nodes = load([shape("a", 0, 0), note("n", 300, 0)]);
    expect(nodes.map((n) => n.id)).toEqual(["a", "n"]);
    expect(frames(nodes)).toHaveLength(0);
  });
});

describe("old shape groups", () => {
  const legacy = () => load([
    shape("far", 900, 900),
    shape("a", 100, 200, { groupIds: ["g1"] }),
    shape("b", 400, 300, { groupIds: ["g1"] }),
  ]);

  it("become one unnamed Frame painted behind its members", () => {
    const nodes = legacy();
    expect(frames(nodes)).toHaveLength(1);
    const frame = frames(nodes)[0];
    expect(frame.title).toBe("Frame 1");
    const order = nodes.map((n) => n.id);
    expect(order.indexOf(frame.id)).toBeLessThan(order.indexOf("a"));
    expect(order.indexOf(frame.id)).toBeLessThan(order.indexOf("b"));
  });

  it("hug the members exactly (padding 0), leaving the members where they were", () => {
    const nodes = legacy();
    const frame = frames(nodes)[0];
    // members span x 100..500, y 200..350
    expect(frame.position).toEqual({ x: 100, y: 200 });
    expect(frame.size).toEqual({ w: 400, h: 150 });
    expect(byId(nodes, "a").position).toEqual({ x: 100, y: 200 });
  });

  it("point members at the Frame and stop carrying group ids", () => {
    const nodes = legacy();
    const frame = frames(nodes)[0];
    for (const id of ["a", "b"]) {
      const n = byId(nodes, id) as CanvasNodeRecord & { frameId?: string; groupIds?: string[] };
      expect(n.frameId).toBe(frame.id);
      expect(n).not.toHaveProperty("groupIds");
    }
    expect(byId(nodes, "far")).not.toHaveProperty("frameId");
  });

  it("number several groups Frame 1, Frame 2 in array order", () => {
    const nodes = load([
      shape("a", 0, 0, { groupIds: ["g1"] }), shape("b", 10, 0, { groupIds: ["g1"] }),
      shape("c", 500, 0, { groupIds: ["g2"] }), shape("d", 510, 0, { groupIds: ["g2"] }),
    ]);
    expect(frames(nodes).map((f) => f.title)).toEqual(["Frame 1", "Frame 2"]);
  });

  it("keep only the outermost group of a nested pair; inner groups are dropped", () => {
    const nodes = load([
      shape("a", 0, 0, { groupIds: ["inner", "outer"] }), shape("b", 100, 0, { groupIds: ["inner", "outer"] }),
      shape("c", 300, 0, { groupIds: ["outer"] }),
    ]);
    expect(frames(nodes)).toHaveLength(1);
    for (const id of ["a", "b", "c"]) expect((byId(nodes, id) as { frameId?: string }).frameId).toBe(frames(nodes)[0].id);
  });

  it("do not make a Frame out of a lone leftover member", () => {
    const nodes = load([shape("a", 0, 0, { groupIds: ["g1"] })]);
    expect(frames(nodes)).toHaveLength(0);
    expect(byId(nodes, "a")).not.toHaveProperty("groupIds");
  });
});

describe("agent diagram frames", () => {
  const diagram = () => load([
    shape("old-frame", 0, 0, { size: { w: 600, h: 400 }, diagramFrame: true, diagramId: "D1", areaLabel: "Login flow", groupIds: ["g9"] }),
    shape("s1", 40, 60, { diagramId: "D1", diagramNodeId: "login", groupIds: ["g9"] }),
    shape("s2", 300, 60, { diagramId: "D1", diagramNodeId: "home", groupIds: ["g9"] }),
    shape("other", 700, 700, { diagramId: "D2", diagramNodeId: "x" }),
  ]);

  it("become a real Frame titled by the diagram label, same box as the old frame rect", () => {
    const nodes = diagram();
    expect(frames(nodes)).toHaveLength(1);
    const frame = frames(nodes)[0];
    expect(frame.title).toBe("Login flow");
    expect(frame.position).toEqual({ x: 0, y: 0 });
    expect(frame.size).toEqual({ w: 600, h: 400 });
    expect(frame.diagramId).toBe("D1");
    expect(nodes.find((n) => n.type === "shape" && (n as { diagramFrame?: boolean }).diagramFrame)).toBeUndefined();
  });

  it("make that diagram's shapes the members, and no one else", () => {
    const nodes = diagram();
    const frame = frames(nodes)[0];
    expect((byId(nodes, "s1") as { frameId?: string }).frameId).toBe(frame.id);
    expect((byId(nodes, "s2") as { frameId?: string }).frameId).toBe(frame.id);
    expect(byId(nodes, "other")).not.toHaveProperty("frameId");
  });

  it("keep the diagram marks on members so edit-in-place can still find them", () => {
    expect(byId(diagram(), "s1")).toMatchObject({ diagramId: "D1", diagramNodeId: "login" });
  });

  it("do not also spawn a group Frame from the diagram's shared group id", () => {
    expect(frames(diagram())).toHaveLength(1);
  });

  it("a diagram frame with no label gets a numbered title", () => {
    const nodes = load([
      shape("f", 0, 0, { diagramFrame: true, diagramId: "D1" }),
      shape("s", 10, 10, { diagramId: "D1" }),
    ]);
    expect(frames(nodes)[0].title).toBe("Frame 1");
  });
});

describe("a canvas that already has Frames", () => {
  it("is left alone", () => {
    const nodes = load([
      { type: "frame", id: "fr", position: { x: 0, y: 0 }, size: { w: 300, h: 300 }, title: "Mine" },
      { ...note("n", 10, 10), frameId: "fr" },
    ]);
    expect(frames(nodes).map((f) => f.title)).toEqual(["Mine"]);
    expect((byId(nodes, "n") as { frameId?: string }).frameId).toBe("fr");
  });
});
