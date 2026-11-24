import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { applyDrawApplication, captureRestore, clearDraftFlags, revertDraftBatch } from "../canvas-draw-commit";

const node = (id: string, data: Record<string, unknown> = {}, className?: string): Node => ({ id, type: "shape", position: { x: 0, y: 0 }, data, ...(className ? { className } : {}) });
const edge = (id: string, source: string, target: string, data: Record<string, unknown> = {}, className?: string): Edge => ({ id, source, target, data, ...(className ? { className } : {}) });

describe("applyDrawApplication", () => {
  it("appends new nodes and edges while preserving existing ones", () => {
    const { nodes, edges } = applyDrawApplication(
      [node("a")], [edge("e0", "a", "a")],
      { nodes: [node("b"), node("c")], edges: [edge("e1", "b", "c")], patches: [], removeIds: [] },
    );
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(edges.map((e) => e.id)).toEqual(["e0", "e1"]);
  });

  it("merges update patches into existing node data without touching others", () => {
    const { nodes } = applyDrawApplication(
      [node("a", { text: "old", keep: 1 }), node("b", { text: "b" })], [],
      { nodes: [], edges: [], patches: [{ id: "a", patch: { text: "new" } }], removeIds: [] },
    );
    expect(nodes[0].data).toEqual({ text: "new", keep: 1 });
    expect(nodes[1].data).toEqual({ text: "b" });
  });

  it("removes deleted nodes and any edge touching them", () => {
    const { nodes, edges } = applyDrawApplication(
      [node("a"), node("b")], [edge("e1", "a", "b"), edge("e2", "b", "b")],
      { nodes: [], edges: [], patches: [], removeIds: ["a"] },
    );
    expect(nodes.map((n) => n.id)).toEqual(["b"]);
    expect(edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("does not mutate the input arrays", () => {
    const input = [node("a")];
    applyDrawApplication(input, [], { nodes: [node("b")], edges: [], patches: [], removeIds: [] });
    expect(input.map((n) => n.id)).toEqual(["a"]);
  });
});

describe("clearDraftFlags", () => {
  it("strips the draft flag + class only from the batch's nodes/edges, preserving other classes", () => {
    const { nodes, edges } = clearDraftFlags(
      [node("a", { agentDraft: true, shape: "rectangle" }, "canvas-agent-draft"), node("z", { agentDraft: true }, "canvas-agent-draft")],
      [edge("e1", "a", "a", { agentDraft: true, wireKind: "connector" }, "canvas-wire canvas-agent-draft")],
      { nodeIds: ["a"], edgeIds: ["e1"] },
    );
    expect((nodes[0].data as { agentDraft?: boolean }).agentDraft).toBeUndefined();
    expect(nodes[0].data.shape).toBe("rectangle");
    expect(nodes[0].className).toBeUndefined();
    expect((nodes[1].data as { agentDraft?: boolean }).agentDraft).toBe(true); // not in batch
    expect(nodes[1].className).toBe("canvas-agent-draft");
    expect((edges[0].data as { agentDraft?: boolean }).agentDraft).toBeUndefined();
    expect((edges[0].data as { wireKind?: string }).wireKind).toBe("connector");
    expect(edges[0].className).toBe("canvas-wire"); // draft class removed, base class kept
  });
});

describe("revertDraftBatch", () => {
  it("removes the batch's nodes and edges, and edges dangling from removed nodes", () => {
    const { nodes, edges } = revertDraftBatch(
      [node("a"), node("b"), node("keep")],
      [edge("e1", "a", "b"), edge("e2", "keep", "a"), edge("keepEdge", "keep", "keep")],
      { nodeIds: ["a", "b"], edgeIds: ["e1"] },
    );
    expect(nodes.map((n) => n.id)).toEqual(["keep"]);
    // e1 (batch edge) + e2 (dangling to removed 'a') gone; keepEdge stays.
    expect(edges.map((e) => e.id)).toEqual(["keepEdge"]);
  });

  it("restores nodes/edges the batch removed and prior data of nodes it patched (true inverse)", () => {
    // Simulate an edit that: created 'new', removed pre-existing 'old' (+ its edge), and patched 'p'.
    const priorOld = node("old", { text: "original" });
    const priorEdge = edge("oe", "old", "p");
    const patchedNow = node("p", { text: "CHANGED" });
    const createdNow = node("new", { agentDraft: true });
    const restore = {
      removedNodes: [priorOld],
      removedEdges: [priorEdge],
      patchedNodes: [{ id: "p", data: { text: "original-p" } }],
    };
    const { nodes, edges } = revertDraftBatch(
      [patchedNow, createdNow],
      [],
      { nodeIds: ["new"], edgeIds: [], restore },
    );
    // Created node gone; removed node + edge re-added; patched node restored to prior data.
    expect(nodes.find((n) => n.id === "new")).toBeUndefined();
    expect(nodes.find((n) => n.id === "old")?.data).toEqual({ text: "original" });
    expect(nodes.find((n) => n.id === "p")?.data).toEqual({ text: "original-p" });
    expect(edges.map((e) => e.id)).toEqual(["oe"]);
  });
});

describe("captureRestore", () => {
  it("snapshots removed nodes/edges and patched nodes' prior data before an application is applied", () => {
    const restore = captureRestore(
      [node("keep"), node("del", { text: "bye" }), node("patch", { text: "before" })],
      [edge("e1", "del", "keep"), edge("e2", "keep", "keep")],
      { patches: [{ id: "patch", patch: { text: "after" } }], removeIds: ["del"] },
    );
    expect(restore.removedNodes.map((n) => n.id)).toEqual(["del"]);
    expect(restore.removedEdges.map((e) => e.id)).toEqual(["e1"]); // edge touching removed 'del'
    expect(restore.patchedNodes).toEqual([{ id: "patch", data: { text: "before" } }]);
  });
});
