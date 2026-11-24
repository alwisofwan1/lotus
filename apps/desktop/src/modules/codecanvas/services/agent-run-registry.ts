import type { GraphRunNodeResult } from "./graph-run-record";

/** Context handed to a node when the graph runner dispatches it. */
export interface AgentRunContext {
  /** The graph run that drove this dispatch; null/undefined for manual single runs. */
  graphRunId?: string | null;
  /** The run's title + goal, for nodes that need a task handed to them (live agents). */
  run?: { title: string; brief: string };
  /** Nodes this one depends on in the run (they completed before it was dispatched). */
  upstreamIds?: string[];
}

export interface AgentRunHandle {
  /** Starts the node's agent (graph-driven run). */
  run: (ctx?: AgentRunContext) => void;
}

export type AgentResultListener = (nodeId: string, ok: boolean, result?: GraphRunNodeResult) => void;

export interface AgentRunRegistry {
  register(nodeId: string, handle: AgentRunHandle): () => void;
  /** True when a node has a live run handle registered on the canvas. */
  has(nodeId: string): boolean;
  /** Dispatches a graph/manual run. Returns false when the node is not runnable. */
  run(nodeId: string, ctx?: AgentRunContext): boolean;
  reportResult(nodeId: string, ok: boolean, result?: GraphRunNodeResult): void;
  subscribeResults(listener: AgentResultListener): () => void;
}

/**
 * Decouples the graph runner from individual AgentNode hooks: nodes register a
 * run handle and report completions; the runner triggers runs and listens for
 * results. Mirrors the terminal-session-registry pattern.
 */
export function createAgentRunRegistry(): AgentRunRegistry {
  const handles = new Map<string, AgentRunHandle>();
  const listeners = new Set<AgentResultListener>();
  return {
    register(nodeId, handle) {
      handles.set(nodeId, handle);
      return () => { if (handles.get(nodeId) === handle) handles.delete(nodeId); };
    },
    has(nodeId) {
      return handles.has(nodeId);
    },
    run(nodeId, ctx) {
      const handle = handles.get(nodeId);
      if (!handle) return false;
      handle.run(ctx);
      return true;
    },
    reportResult(nodeId, ok, result) {
      listeners.forEach((listener) => listener(nodeId, ok, result));
    },
    subscribeResults(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Process-wide registry shared by AgentNodes and the canvas graph runner. */
export const agentRunRegistry: AgentRunRegistry = createAgentRunRegistry();
