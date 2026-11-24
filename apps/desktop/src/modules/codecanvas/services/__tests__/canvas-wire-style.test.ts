import { describe, expect, it, vi } from "vitest";
import { buildCanvasWireEdge, canvasWireClassName } from "../canvas-wire-style";

describe("canvas-wire-style", () => {
  it("maps wire kinds to stable CSS classes", () => {
    expect(canvasWireClassName("default")).toBe("canvas-wire canvas-wire--default");
    expect(canvasWireClassName("skills")).toBe("canvas-wire canvas-wire--skills");
    expect(canvasWireClassName("skill-preview")).toBe("canvas-wire canvas-wire--skill-preview");
    expect(canvasWireClassName("context")).toBe("canvas-wire canvas-wire--context");
  });

  it("builds production edge metadata from a wire kind", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("edge-id" as `${string}-${string}-${string}-${string}-${string}`);

    expect(buildCanvasWireEdge({ source: "term-1", target: "skills-1", kind: "skills", animated: true })).toEqual({
      id: "edge-id",
      source: "term-1",
      target: "skills-1",
      animated: true,
      type: "canvas-wire",
      className: "canvas-wire canvas-wire--skills",
      interactionWidth: 24,
      reconnectable: true,
      data: { wireKind: "skills" },
    });
  });

  it("labels and arrows agent workflow wires, but leaves plain/provenance wires quiet", () => {
    const context = buildCanvasWireEdge({ source: "note", target: "agent", kind: "context" });
    expect(context).toMatchObject({ label: "context", markerEnd: { type: "arrowclosed" } });
    expect(buildCanvasWireEdge({ source: "a1", target: "a2", kind: "triggers" }).label).toBe("triggers");
    expect(buildCanvasWireEdge({ source: "term", target: "skills", kind: "skills" }).markerEnd).toBeUndefined();
    expect(buildCanvasWireEdge({ source: "t1", target: "n1", kind: "default" }).label).toBeUndefined();
  });

  it("preserves the connected handle sides when given, omits them otherwise", () => {
    const withHandles = buildCanvasWireEdge({ source: "a", target: "b", sourceHandle: "wire-bottom", targetHandle: "wire-top" });
    expect(withHandles.sourceHandle).toBe("wire-bottom");
    expect(withHandles.targetHandle).toBe("wire-top");
    const plain = buildCanvasWireEdge({ source: "a", target: "b" });
    expect(plain.sourceHandle).toBeUndefined();
    expect(plain.targetHandle).toBeUndefined();
  });
});
