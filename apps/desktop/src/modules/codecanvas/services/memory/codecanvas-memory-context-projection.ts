import type { CodeCanvasMemoryItem } from "@/lib/tauri/codecanvas";
import type { ContextArtifact } from "../context-bus-record";

/**
 * Phase 5: the Context Node becomes a projection over project memory, not a separate storage island.
 * These pure helpers map durable project-memory rows into the Context Bus's {@link ContextArtifact}
 * shape and merge them behind the node's own run artifacts — additive, with the live bus authoritative.
 */

/** Durable, human-relevant kinds worth surfacing on a Context Bus. Transient chatter is excluded. */
const PROJECTED_KINDS = new Set(["artifact", "note", "decision", "constraint", "external-context"]);

export function projectMemoryAsContextArtifacts(
  items: CodeCanvasMemoryItem[],
  busNodeId: string,
): ContextArtifact[] {
  return items
    .filter((item) => !item.archivedAt && PROJECTED_KINDS.has(item.kind))
    .map((item) => ({
      id: `mem:${item.id}`,
      projectId: item.projectId,
      busNodeId,
      key: item.title?.trim() || `${item.kind}:${item.id.slice(-6)}`,
      value: item.summary?.trim() || item.body,
      producer: item.actorId?.trim() || item.source,
      version: 1,
      graphRunId: item.runId ?? null,
      updatedAt: item.updatedAt,
    }));
}

/**
 * Merge live bus artifacts with projected project-memory entries. Bus artifacts keep their position
 * and win on key collisions, so nothing an agent published this run is displaced by durable memory.
 */
export function mergeContextArtifacts(
  busArtifacts: ContextArtifact[],
  projected: ContextArtifact[],
): ContextArtifact[] {
  const busKeys = new Set(busArtifacts.map((artifact) => artifact.key));
  const extra = projected.filter((artifact) => !busKeys.has(artifact.key));
  return [...busArtifacts, ...extra];
}
