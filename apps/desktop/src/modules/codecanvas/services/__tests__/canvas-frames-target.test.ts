import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { frameIdOf, placeInTargetFrame, resolveAgentFrameRef as resolveFrameRef } from "../canvas-frames";

const frame = (id: string, title: string, x = 0, y = 0, w = 1000, h = 800): Node => ({
  id, type: "frame", position: { x, y }, width: w, height: h, data: { title },
});
const member = (id: string, frameId: string, x: number, y: number): Node => ({
  id, type: "agent", position: { x, y }, width: 300, height: 200, data: { frameId },
});
const fresh = (id = "new", w = 300, h = 200): Node => ({
  id, type: "agent", position: { x: 9000, y: 9000 }, width: w, height: h, data: {},
});

describe("resolveFrame (exact mode, as the MCP spawn uses it)", () => {
  const nodes = [frame("f1", "Backend"), frame("f2", "Docs", 2000)];

  it("resolves by id", () => {
    expect(resolveFrameRef(nodes, "f2")).toEqual({ id: "f2" });
  });
  it("resolves by exact title", () => {
    expect(resolveFrameRef(nodes, "Backend")).toEqual({ id: "f1" });
  });
  it("does not match a title loosely", () => {
    expect("error" in resolveFrameRef(nodes, "backend")).toBe(true);
    expect("error" in resolveFrameRef(nodes, "Back")).toBe(true);
  });
  it("names the available Frames when the ref is unknown", () => {
    const r = resolveFrameRef(nodes, "Nope");
    expect(r).toEqual({ error: expect.stringContaining("Backend") });
    expect((r as { error: string }).error).toContain("Docs");
  });
  it("says there are no Frames when the board has none", () => {
    expect((resolveFrameRef([], "x") as { error: string }).error).toMatch(/no Frames/i);
  });
  it("refuses an ambiguous title and asks for the id", () => {
    const r = resolveFrameRef([frame("a", "Same"), frame("b", "Same")], "Same");
    expect((r as { error: string }).error).toMatch(/more than one/i);
  });
  it("prefers an id match over a title that equals another Frame's id", () => {
    expect(resolveFrameRef([frame("f1", "f2"), frame("f2", "Other")], "f2")).toEqual({ id: "f2" });
  });
});

describe("placeInTargetFrame", () => {
  it("adds the node, points it at the Frame, and puts it inside the Frame box", () => {
    const out = placeInTargetFrame([frame("f1", "A", 100, 100)], fresh(), "f1");
    const n = out.find((x) => x.id === "new")!;
    expect(frameIdOf(n)).toBe("f1");
    expect(n.position.x).toBeGreaterThanOrEqual(100);
    expect(n.position.y).toBeGreaterThanOrEqual(100);
    expect(n.position.x + 300).toBeLessThanOrEqual(1100);
    expect(n.position.y + 200).toBeLessThanOrEqual(900);
  });

  it("does not stack on top of an existing member", () => {
    const out = placeInTargetFrame([frame("f1", "A"), member("m", "f1", 40, 76)], fresh(), "f1");
    const n = out.find((x) => x.id === "new")!;
    const m = out.find((x) => x.id === "m")!;
    const overlap =
      n.position.x < m.position.x + 300 && n.position.x + 300 > m.position.x &&
      n.position.y < m.position.y + 200 && n.position.y + 200 > m.position.y;
    expect(overlap).toBe(false);
  });

  it("grows the Frame to contain a node that does not fit", () => {
    const out = placeInTargetFrame([frame("f1", "Tiny", 0, 0, 200, 150)], fresh("big", 700, 500), "f1");
    const f = out.find((x) => x.id === "f1")!;
    const n = out.find((x) => x.id === "big")!;
    expect(n.position.x + 700).toBeLessThanOrEqual(f.position.x + (f.width as number));
    expect(n.position.y + 500).toBeLessThanOrEqual(f.position.y + (f.height as number));
  });

  it("keeps the Frame before its members in array order (paints behind)", () => {
    const out = placeInTargetFrame([frame("f1", "A")], fresh(), "f1");
    expect(out.findIndex((x) => x.id === "f1")).toBeLessThan(out.findIndex((x) => x.id === "new"));
  });

  it("leaves other nodes untouched", () => {
    const other: Node = { id: "o", type: "note", position: { x: 5, y: 5 }, data: {} };
    const out = placeInTargetFrame([frame("f1", "A"), other], fresh(), "f1");
    expect(out.find((x) => x.id === "o")).toBe(other);
  });
});
