"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CanvasRunScheduler, type RunDependency } from "../services/canvas-run-scheduler";
import { agentRunRegistry, type AgentRunRegistry } from "../services/agent-run-registry";

export interface PendingTaskRun {
  agentIds: string[];
  deps: RunDependency[];
}

export interface UseCanvasTaskDispatchResult {
  /** Queue a dispatched subgraph; its roots run once the new agent nodes have mounted. */
  schedule: (run: PendingTaskRun) => void;
}

/**
 * Drives auto-run for a freshly dispatched task subgraph: it queues the run and
 * fires it on the next commit (after the new AgentNodes have mounted and
 * registered their run handles), then walks the dependency order — exactly the
 * graph-run protocol, scoped to the dispatch instead of the whole board.
 */
export function useCanvasTaskDispatch(registry: AgentRunRegistry = agentRunRegistry): UseCanvasTaskDispatchResult {
  const queueRef = useRef<PendingTaskRun[]>([]);
  const unsubsRef = useRef<Set<() => void>>(new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => () => { unsubsRef.current.forEach((u) => u()); unsubsRef.current.clear(); }, []);

  const schedule = useCallback((run: PendingTaskRun) => {
    queueRef.current.push(run);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const run = queueRef.current.shift();
    if (!run || run.agentIds.length === 0) return;
    const scheduler = new CanvasRunScheduler(run.agentIds, run.deps);
    scheduler.start().forEach((id) => registry.run(id));
    const unsub = registry.subscribeResults((id) => {
      scheduler.complete(id).forEach((next) => registry.run(next));
      if (scheduler.isDone()) { unsub(); unsubsRef.current.delete(unsub); }
    });
    unsubsRef.current.add(unsub);
  }, [tick, registry]);

  return { schedule };
}
