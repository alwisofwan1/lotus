import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { duplicateShapes } from "../canvas-duplicate";

const counter = (prefix: string) => {
  let i = 0;
  return () => `${prefix}${++i}`;
};

const shape = (id: string, data: Record<string, unknown> = {}, extra: Partial<Node> = {}): Node => ({
  id,
  type: "shape",
  position: { x: 100, y: 50 },
  width: 120,
  height: 80,
  data: { shape: "rectangle", ...data },
  ...extra,
});

const dup = (nodes: Node[]) => duplicateShapes(nodes, { newId: counter("n") });

describe("duplicateShapes", () => {
  it("offsets by 24 and keeps size, style, text, rotation", () => {
    const [copy] = dup([shape("a", { angle: 30, text: "hi", style: { strokeColor: "#f00" } })]);
    expect(copy.id).toBe("n1");
    expect(copy.position).toEqual({ x: 124, y: 74 });
    expect(copy.width).toBe(120);
    expect(copy.height).toBe(80);
    expect(copy.data).toMatchObject({ shape: "rectangle", angle: 30, text: "hi", style: { strokeColor: "#f00" } });
  });

  it("keeps the image asset so the copy survives reload", () => {
    const [copy] = dup([shape("a", { shape: "image", imageAssetUri: "asset://x", imageAlt: "alt", imageNaturalWidth: 640, imageNaturalHeight: 480 })]);
    expect(copy.data).toMatchObject({ shape: "image", imageAssetUri: "asset://x", imageAlt: "alt", imageNaturalWidth: 640, imageNaturalHeight: 480 });
  });

  it("a copy of a Frame member stays in that Frame; a loose shape stays loose", () => {
    const copies = dup([shape("a", { frameId: "f1" }), shape("c")]);
    expect((copies[0].data as { frameId?: string }).frameId).toBe("f1");
    expect(copies[1].data).not.toHaveProperty("frameId");
  });

  it("drops diagram identity so edit-in-place never targets the copy", () => {
    const [copy] = dup([shape("a", { diagramId: "d", diagramFrame: true, diagramNodeId: "x" })]);
    expect(copy.data).not.toHaveProperty("diagramId");
    expect(copy.data).not.toHaveProperty("diagramFrame");
    expect(copy.data).not.toHaveProperty("diagramNodeId");
  });

  it("ignores non-shape nodes and never carries selection", () => {
    const copies = dup([shape("a", {}, { selected: true }), { id: "t", type: "note", position: { x: 0, y: 0 }, data: {} }]);
    expect(copies).toHaveLength(1);
    expect(copies[0].selected).toBeFalsy();
  });
});
