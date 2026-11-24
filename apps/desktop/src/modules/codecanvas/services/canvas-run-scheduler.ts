import type { Node, Edge } from "@xyflow/react";
import { isSemanticEdgeKind } from "./canvas-edge-semantics";

export interface RunDependency {
  /** Must complete before `to` may start. */
  from: string;
  to: string;
}

export interface RunGraph {
  nodeIds: string[];
  deps: RunDependency[];
}

/** Node types a graph run can dispatch. */
export function isRunnableNodeType(type: string | undefined): boolean {
  return type === "agent" || type === "team" || type === "critic" || type === "human-gate";
}

/**
 * Extracts the runnable graph: agent, team, critic, and human gate nodes, plus dependencies
 * from execution edges (triggers/orchestrates) between two runnable nodes. A Critic Node
 * runs like an agent and gates its dependents (N4). A Human Gate Node pauses until a user
 * approves or rejects it. data-flow/plain wires and other node types are ignored.
 *
 * `scope` limits the graph to those node ids (a Run Node's members): a node outside it is never
 * dispatched, and an edge counts only when both ends are inside. No scope = the whole canvas.
 */
/** Only a "triggers" or "orchestrates" wire orders a run; any other wire is context, not order. */
export function isExecutionEdge(edge: Pick<Edge, "data">): boolean {
  const kind = (edge.data as { wireKind?: string } | undefined)?.wireKind ?? "default";
  return (kind === "triggers" || kind === "orchestrates") && isSemanticEdgeKind(kind);
}

export function buildRunGraph(nodes: Node[], edges: Edge[], scope?: ReadonlySet<string>): RunGraph {
  const runnableIds = new Set(nodes.filter((n) => isRunnableNodeType(n.type) && (!scope || scope.has(n.id))).map((n) => n.id));
  const deps: RunDependency[] = [];
  for (const e of edges) {
    if (isExecutionEdge(e) && runnableIds.has(e.source) && runnableIds.has(e.target)) {
      deps.push({ from: e.source, to: e.target });
    }
  }
  return { nodeIds: [...runnableIds], deps };
}

/**
 * Drives a topological run over agent nodes: hand out roots, then release each
 * dependent once all of its dependencies finish. Pure and synchronous — the
 * React layer feeds completions in and spawns whatever the scheduler hands back.
 */
export class CanvasRunScheduler {
  private readonly remaining: Map<string, Set<string>>;
  private readonly deps: RunDependency[];
  private readonly completed = new Set<string>();
  private readonly started = new Set<string>();
  private readonly blocked = new Set<string>();

  constructor(nodeIds: string[], deps: RunDependency[], seedCompleted: string[] = []) {
    this.deps = deps;
    this.remaining = new Map(nodeIds.map((id) => [id, new Set<string>()]));
    for (const { from, to } of deps) {
      if (this.remaining.has(to) && this.remaining.has(from)) this.remaining.get(to)!.add(from);
    }
    // Resume support: nodes already finished in a prior run are not re-dispatched.
    for (const id of seedCompleted) {
      if (this.remaining.has(id)) this.completed.add(id);
    }
  }

  /**
   * Closes a gate (a failed Critic Node): its downstream descendants are blocked and will
   * never dispatch. Returns the blocked ids. The gate node itself is still completed by the
   * caller so the run can settle. Already-completed descendants are left untouched.
   */
  block(nodeId: string): string[] {
    const blocked: string[] = [];
    for (const id of descendantsOf(nodeId, this.deps)) {
      if (!this.completed.has(id) && this.remaining.has(id)) { this.blocked.add(id); blocked.push(id); }
    }
    return blocked;
  }

  /** Returns the initially runnable nodes (no unmet dependency). */
  start(): string[] {
    return this.release();
  }

  /** Marks a node finished and returns nodes newly unblocked by it. Unknown ids are ignored. */
  complete(nodeId: string): string[] {
    if (!this.remaining.has(nodeId)) return [];
    this.completed.add(nodeId);
    return this.release();
  }

  isDone(): boolean {
    return this.completed.size + this.blocked.size === this.remaining.size;
  }

  /** Unfinished, unblocked nodes that still need a terminal outcome. */
  pending(): string[] {
    return [...this.remaining.keys()]
      .filter((id) => !this.completed.has(id) && !this.blocked.has(id))
      .sort();
  }

  /** True when unfinished nodes remain but none can ever run (dependency cycle). */
  hasCycle(): boolean {
    return !this.isDone() && this.runnable().length === 0;
  }

  private runnable(): string[] {
    return [...this.remaining.entries()]
      .filter(([id, deps]) => !this.completed.has(id) && !this.started.has(id) && !this.blocked.has(id)
        && [...deps].every((d) => this.completed.has(d)))
      .map(([id]) => id);
  }

  private release(): string[] {
    const ready = this.runnable().sort(); // deterministic dispatch order across runs/replays
    ready.forEach((id) => this.started.add(id));
    return ready;
  }
}

/** Transitive descendants of `nodeId` along the dependency edges, sorted. Cycle-safe. */
export function descendantsOf(nodeId: string, deps: RunDependency[]): string[] {
  const found = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const { from, to } of deps) {
      if (from === current && !found.has(to)) {
        found.add(to);
        queue.push(to);
      }
    }
  }
  return [...found].sort();
}
