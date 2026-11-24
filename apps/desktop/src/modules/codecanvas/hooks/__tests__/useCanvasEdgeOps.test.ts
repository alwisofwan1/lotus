import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { useCanvasEdgeOps } from "../useCanvasEdgeOps";

function harness(initialEdges: Edge[], nodes: Node[], autosave = vi.fn()) {
  return renderHook(() => {
    const [edges, setEdges] = useState<Edge[]>(initialEdges);
    const nodesRef = useRef<Node[]>(nodes);
    const edgesRef = useRef<Edge[]>(edges);
    edgesRef.current = edges;
    const autosaveRef = useRef(autosave);
    const ops = useCanvasEdgeOps({ setEdges, nodesRef, edgesRef, autosaveRef });
    return { edges, ...ops };
  });
}

const NODES: Node[] = [
  { id: "term-1", type: "terminal", position: { x: 0, y: 0 } } as Node,
  { id: "note-1", type: "note", position: { x: 0, y: 0 } } as Node,
  { id: "agent-1", type: "agent", position: { x: 0, y: 0 } } as Node,
  { id: "agent-2", type: "agent", position: { x: 0, y: 0 } } as Node,
  { id: "skills-1", type: "skills", position: { x: 0, y: 0 } } as Node,
];

describe("useCanvasEdgeOps", () => {
  it("connects two nodes into a typed, autosaved wire", () => {
    const autosave = vi.fn();
    const { result } = harness([], NODES, autosave);
    act(() => result.current.onConnect({ source: "term-1", target: "note-1", sourceHandle: null, targetHandle: null }));
    expect(result.current.edges).toHaveLength(1);
    expect(result.current.edges[0]).toMatchObject({ source: "term-1", target: "note-1", type: "canvas-wire" });
    expect(autosave).toHaveBeenCalled();
  });

  it("retypes, re-ports, reconnects and deletes an edge", () => {
    const edge: Edge = { id: "e1", source: "term-1", target: "note-1" };
    const { result } = harness([edge], NODES);

    act(() => result.current.setEdgeKind("e1", "triggers"));
    expect(result.current.edges[0]).toMatchObject({ label: "triggers", data: { wireKind: "triggers" } });

    act(() => result.current.setEdgeHandle("e1", "source", "wire-bottom"));
    expect(result.current.edges[0]).toMatchObject({ sourceHandle: "wire-bottom" });

    act(() => result.current.onReconnect(result.current.edges[0], { source: "note-1", target: "term-1", sourceHandle: null, targetHandle: null }));
    expect(result.current.edges[0]).toMatchObject({ source: "note-1", target: "term-1", data: { wireKind: "default" } });

    act(() => result.current.removeEdge("e1"));
    expect(result.current.edges).toEqual([]);
  });

  it("infers context wires and rejects invalid user connections", () => {
    const { result } = harness([], NODES);
    act(() => result.current.onConnect({ source: "note-1", target: "agent-1", sourceHandle: null, targetHandle: null }));
    expect(result.current.edges[0]).toMatchObject({ label: "context", data: { wireKind: "context" } });

    act(() => result.current.onConnect({ source: "note-1", target: "agent-1", sourceHandle: null, targetHandle: null }));
    act(() => result.current.onConnect({ source: "agent-1", target: "agent-1", sourceHandle: null, targetHandle: null }));
    act(() => result.current.onConnect({ source: "term-1", target: "skills-1", sourceHandle: null, targetHandle: null }));
    expect(result.current.edges).toHaveLength(1);
  });

  it("cycles agent → agent wires only through executable workflow meanings", () => {
    const { result } = harness([{ id: "e1", source: "agent-1", target: "agent-2", data: { wireKind: "triggers" } }], NODES);
    act(() => result.current.cycleEdgeSemantic("e1"));
    expect(result.current.edges[0]).toMatchObject({ data: { wireKind: "orchestrates" } });
    act(() => result.current.cycleEdgeSemantic("e1"));
    expect(result.current.edges[0]).toMatchObject({ data: { wireKind: "triggers" } });
  });
});
