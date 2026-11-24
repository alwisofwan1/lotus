/** One named artifact on a Context Node's bus — a freeform text payload an agent published. */
export interface ContextArtifact {
  id: string;
  projectId: string;
  /** The Context Node this artifact belongs to (the bus surface). */
  busNodeId: string;
  /** Named slot — defaults to the producer agent's name (re-runs overwrite the same key). */
  key: string;
  value: string;
  /** Display name of the agent (or "user") that produced it. */
  producer: string;
  version: number;
  /** The graph run that produced it; null for manual/ad-hoc writes. Drives the staleness guard. */
  graphRunId: string | null;
  updatedAt: number;
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `artifact-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

/** Version for the next write of a key: 1 if new, else previous + 1. */
export function nextVersion(previous: { version: number } | null | undefined): number {
  return (previous?.version ?? 0) + 1;
}

export function buildArtifact(input: {
  projectId: string;
  busNodeId: string;
  key: string;
  value: string;
  producer: string;
  graphRunId: string | null;
  now: number;
  version?: number;
  id?: string;
}): ContextArtifact {
  return {
    id: input.id ?? newId(),
    projectId: input.projectId,
    busNodeId: input.busNodeId,
    key: input.key,
    value: input.value,
    producer: input.producer,
    version: input.version ?? 1,
    graphRunId: input.graphRunId,
    updatedAt: input.now,
  };
}

/**
 * True when an artifact was produced in a different run than the one now reading it —
 * i.e. a downstream agent is consuming data from an earlier run. Returns false when
 * either side lacks a run id (manual run or untagged artifact): we cannot judge, so we
 * never warn spuriously.
 */
export function isStale(artifact: ContextArtifact, activeGraphRunId: string | null): boolean {
  if (!activeGraphRunId || !artifact.graphRunId) return false;
  return artifact.graphRunId !== activeGraphRunId;
}
