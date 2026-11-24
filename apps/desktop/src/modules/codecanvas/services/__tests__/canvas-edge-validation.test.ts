import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { isValidCanvasConnection } from "../canvas-edge-validation";

const nodes = [
  { id: "note", type: "note", position: { x: 0, y: 0 } },
  { id: "agent", type: "agent", position: { x: 0, y: 0 } },
  { id: "terminal", type: "terminal", position: { x: 0, y: 0 } },
  { id: "skills", type: "skills", position: { x: 0, y: 0 } },
] as Node[];

describe("isValidCanvasConnection", () => {
  it("rejects self loops and missing endpoints", () => {
    expect(isValidCanvasConnection({ source: "agent", target: "agent" }, nodes, [])).toBe(false);
    expect(isValidCanvasConnection({ source: "agent", target: null }, nodes, [])).toBe(false);
  });

  it("rejects duplicate directed node-pair wires", () => {
    const edges: Edge[] = [{ id: "e1", source: "note", target: "agent" }];
    expect(isValidCanvasConnection({ source: "note", target: "agent" }, nodes, edges)).toBe(false);
    expect(isValidCanvasConnection({ source: "agent", target: "note" }, nodes, edges)).toBe(true);
    expect(isValidCanvasConnection({ source: "note", target: "agent" }, nodes, edges, "e1")).toBe(true);
  });

  it("keeps Skills and Skill preview provenance system-owned", () => {
    expect(isValidCanvasConnection({ source: "terminal", target: "skills" }, nodes, [])).toBe(false);
    expect(isValidCanvasConnection({ source: "skills", target: "note" }, nodes, [])).toBe(false);
  });
});
