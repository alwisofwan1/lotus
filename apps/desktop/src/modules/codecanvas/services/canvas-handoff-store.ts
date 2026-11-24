/** The artifact one agent hands off to its downstream agents: its run summary. */
export interface HandoffArtifact {
  /** Display name of the upstream agent that produced it. */
  name: string;
  /** The agent's final result text — the payload carried along the edge. */
  summary: string;
  /** The Claude session that produced it, for an optional continue-session handoff later. */
  sessionId: string | null;
}

/**
 * Session-scoped handoff artifacts held per Canvas Node id. Like the Canvas
 * Attachment Store, it is never written to the Canvas Snapshot — it resets on
 * reload. An upstream Agent Node writes its artifact on completion; a downstream
 * Agent Node reads its connected upstream artifacts at run time (N2 handoff edges).
 */
export class CanvasHandoffStore {
  private byNode = new Map<string, HandoffArtifact>();

  get(nodeId: string): HandoffArtifact | undefined {
    return this.byNode.get(nodeId);
  }

  set(nodeId: string, artifact: HandoffArtifact): void {
    this.byNode.set(nodeId, artifact);
  }

  clear(nodeId: string): void {
    this.byNode.delete(nodeId);
  }

  /** Drop artifacts for any node no longer present (called on node removal/reload). */
  prune(keepIds: Iterable<string>): void {
    const keep = new Set(keepIds);
    for (const id of [...this.byNode.keys()]) {
      if (!keep.has(id)) this.byNode.delete(id);
    }
  }
}

/** App-level singleton — completing agents write, downstream agents read at run time. */
export const canvasHandoffStore = new CanvasHandoffStore();
