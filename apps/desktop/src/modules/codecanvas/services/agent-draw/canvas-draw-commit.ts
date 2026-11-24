import type { Edge, Node } from "@xyflow/react";
import type { DraftBatch, DraftRestore } from "./agent-draw-ledger";
import { DRAFT_CLASS, type DrawApplication } from "./canvas-draw-runtime";

/** Remove the draft wrapper class from a className string, preserving any other classes. */
function stripDraftClass(className: string | undefined): string | undefined {
  if (!className) return className;
  const next = className.split(/\s+/).filter((c) => c && c !== DRAFT_CLASS).join(" ");
  return next.length ? next : undefined;
}

/**
 * Pure graph transforms for applying / reverting an agent draw batch. Kept separate from the
 * hook so the tricky merge (remove + patch + add, in one pass) and the draft lifecycle are
 * unit-testable without ReactFlow or a store. Each returns fresh arrays — no mutation — so the
 * host can hand them straight to `setNodes`/`setEdges` in a single functional update.
 */

/** Apply a built {@link DrawApplication} to the current graph: drop removed nodes (and any edge
 *  touching them), merge update patches, then append the batch's new nodes/edges. */
export function applyDrawApplication(
  nodes: Node[],
  edges: Edge[],
  app: Pick<DrawApplication, "nodes" | "edges" | "patches" | "removeIds">,
): { nodes: Node[]; edges: Edge[] } {
  const removed = new Set(app.removeIds);
  const patches = new Map(app.patches.map((p) => [p.id, p.patch]));
  const nextNodes = nodes
    .filter((n) => !removed.has(n.id))
    .map((n) => (patches.has(n.id) ? { ...n, data: { ...n.data, ...patches.get(n.id) } } : n))
    .concat(app.nodes);
  const nextEdges = edges
    .filter((e) => !removed.has(e.source) && !removed.has(e.target))
    .concat(app.edges);
  return { nodes: nextNodes, edges: nextEdges };
}

/** Accept a draft batch: strip the `agentDraft` provenance flag from its nodes/edges so they
 *  render as ordinary, fully-owned canvas content. */
export function clearDraftFlags(
  nodes: Node[],
  edges: Edge[],
  batch: Pick<DraftBatch, "nodeIds" | "edgeIds">,
): { nodes: Node[]; edges: Edge[] } {
  const nodeIds = new Set(batch.nodeIds);
  const edgeIds = new Set(batch.edgeIds);
  const undraftNode = (n: Node) => {
    if (!nodeIds.has(n.id)) return n;
    const data = { ...n.data } as Record<string, unknown>;
    delete data.agentDraft;
    return { ...n, data, className: stripDraftClass(n.className) };
  };
  const undraftEdge = (e: Edge) => {
    if (!edgeIds.has(e.id)) return e;
    const data = { ...(e.data ?? {}) } as Record<string, unknown>;
    delete data.agentDraft;
    return { ...e, data, className: stripDraftClass(e.className) };
  };
  return { nodes: nodes.map(undraftNode), edges: edges.map(undraftEdge) };
}

/** Capture the pre-existing content an application will remove/patch, BEFORE it is applied, so the
 *  resulting draft batch can be fully reverted on Discard. */
export function captureRestore(
  nodes: Node[],
  edges: Edge[],
  app: Pick<DrawApplication, "patches" | "removeIds">,
): DraftRestore {
  const removed = new Set(app.removeIds);
  const patched = new Set(app.patches.map((p) => p.id));
  return {
    removedNodes: nodes.filter((n) => removed.has(n.id)),
    removedEdges: edges.filter((e) => removed.has(e.source) || removed.has(e.target)),
    patchedNodes: nodes.filter((n) => patched.has(n.id)).map((n) => ({ id: n.id, data: { ...(n.data as Record<string, unknown>) } })),
  };
}

/**
 * Discard a draft batch — the TRUE inverse of its commit: remove the nodes/edges it created, restore
 * the prior data of any node it patched, and re-add anything it removed. Without the restore step a
 * Discard of an edit/replace would leave the deleted or mutated originals gone (data loss).
 */
export function revertDraftBatch(
  nodes: Node[],
  edges: Edge[],
  batch: Pick<DraftBatch, "nodeIds" | "edgeIds" | "restore">,
): { nodes: Node[]; edges: Edge[] } {
  const createdNodes = new Set(batch.nodeIds);
  const createdEdges = new Set(batch.edgeIds);
  // 1) Drop what the batch created (its own edges + any edge dangling from a created node).
  let nextNodes = nodes.filter((n) => !createdNodes.has(n.id));
  let nextEdges = edges.filter((e) => !createdEdges.has(e.id) && !createdNodes.has(e.source) && !createdNodes.has(e.target));
  // 2) Restore prior data on nodes the batch patched (that still exist).
  const priorData = new Map((batch.restore?.patchedNodes ?? []).map((p) => [p.id, p.data]));
  if (priorData.size) nextNodes = nextNodes.map((n) => (priorData.has(n.id) ? { ...n, data: priorData.get(n.id)! } : n));
  // 3) Re-add what the batch removed (skip any id that somehow already came back).
  if (batch.restore) {
    const haveNodes = new Set(nextNodes.map((n) => n.id));
    nextNodes = [...nextNodes, ...batch.restore.removedNodes.filter((n) => !haveNodes.has(n.id))];
    const haveEdges = new Set(nextEdges.map((e) => e.id));
    nextEdges = [...nextEdges, ...batch.restore.removedEdges.filter((e) => !haveEdges.has(e.id))];
  }
  return { nodes: nextNodes, edges: nextEdges };
}
