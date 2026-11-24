import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { reorderNodes, reorderNodesMany } from "../canvas-node-order";

const make = (ids: string[]): Node[] => ids.map((id) => ({ id, position: { x: 0, y: 0 }, data: {} }));

describe("reorderNodes", () => {
  it("brings a node to the front (end of the array paints on top)", () => {
    expect(reorderNodes(make(["a", "b", "c"]), "a", "front").map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("sends a node to the back (start of the array)", () => {
    expect(reorderNodes(make(["a", "b", "c"]), "c", "back").map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("returns an unchanged copy when the id is absent", () => {
    const input = make(["a", "b"]);
    const out = reorderNodes(input, "x", "front");
    expect(out.map((n) => n.id)).toEqual(["a", "b"]);
    expect(out).not.toBe(input);
  });
});

describe("reorderNodesMany", () => {
  it("brings a block to the front, preserving its relative order", () => {
    expect(reorderNodesMany(make(["a", "b", "c", "d"]), ["a", "c"], "front").map((n) => n.id))
      .toEqual(["b", "d", "a", "c"]);
  });

  it("sends a block to the back, preserving its relative order", () => {
    expect(reorderNodesMany(make(["a", "b", "c", "d"]), ["b", "d"], "back").map((n) => n.id))
      .toEqual(["b", "d", "a", "c"]);
  });

  it("derives block order from the array, not the ids argument", () => {
    // ids given out of order → block still keeps array order (a before c).
    expect(reorderNodesMany(make(["a", "b", "c"]), ["c", "a"], "front").map((n) => n.id))
      .toEqual(["b", "a", "c"]);
  });

  it("ignores ids absent from the array", () => {
    expect(reorderNodesMany(make(["a", "b"]), ["a", "x"], "front").map((n) => n.id))
      .toEqual(["b", "a"]);
  });

  it("returns an unchanged copy when no ids match", () => {
    const input = make(["a", "b"]);
    const out = reorderNodesMany(input, ["x"], "back");
    expect(out.map((n) => n.id)).toEqual(["a", "b"]);
    expect(out).not.toBe(input);
  });
});
