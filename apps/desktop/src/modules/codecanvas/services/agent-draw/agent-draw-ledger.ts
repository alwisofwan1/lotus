"use client";

import { useSyncExternalStore } from "react";
import type { Edge, Node } from "@xyflow/react";

/**
 * Draft ledger for agent-drawn batches. When an agent draws more than a few elements, they land
 * as a *draft* the user can Apply or Discard; this module-level store tracks the pending draft
 * batches so the Apply/Discard pill can render and so a Discard can revert exactly the nodes/edges
 * that batch created — the stand-in for a general canvas undo, which does not exist yet.
 *
 * Pure and framework-free apart from the React `useSyncExternalStore` binding: it holds no
 * ReactFlow/DOM state, only the id bookkeeping. The host (CanvasPage) owns the actual board
 * mutation; it records a batch here on commit and calls {@link resolveDraftBatch} once the batch
 * is applied or discarded.
 */
/**
 * Snapshot of the pre-existing content a batch mutated, so Discard is a true inverse: without this,
 * discarding an edit that removed or patched existing shapes would leave that damage in place. Holds
 * the FULL prior node/edge objects to re-add and each patched node's prior data to restore.
 */
export interface DraftRestore {
  removedNodes: Node[];
  removedEdges: Edge[];
  patchedNodes: Array<{ id: string; data: Record<string, unknown> }>;
}

export interface DraftBatch {
  batchId: string;
  /** Node ids this batch created — removed on Discard, un-dimmed on Apply. */
  nodeIds: string[];
  /** Edge ids this batch created. */
  edgeIds: string[];
  /** Human summary for the pill, e.g. "1 frame · 5 shapes · 5 connectors". */
  summary: string;
  /** Drawing agent's handle, when known, for attribution in the pill. */
  agentName?: string;
  /** Prior state of content this batch removed/patched, so Discard can fully restore it. */
  restore?: DraftRestore;
}

let batches: DraftBatch[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function recordDraftBatch(batch: DraftBatch): DraftBatch {
  batches = [...batches, batch];
  emit();
  return batch;
}

export function resolveDraftBatch(batchId: string): void {
  const next = batches.filter((b) => b.batchId !== batchId);
  if (next.length === batches.length) return;
  batches = next;
  emit();
}

export function pendingDraftBatches(): DraftBatch[] {
  return batches;
}

export function latestDraftBatch(): DraftBatch | null {
  return batches.length ? batches[batches.length - 1] : null;
}

export function subscribeDraftLedger(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function clearDraftLedgerForTests(): void {
  batches = [];
  emit();
}

/** React binding: the current pending draft batches, re-rendering on record/resolve. */
export function useDraftBatches(): DraftBatch[] {
  return useSyncExternalStore(subscribeDraftLedger, pendingDraftBatches, () => batches);
}
