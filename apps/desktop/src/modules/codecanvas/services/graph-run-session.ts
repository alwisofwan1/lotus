import { CanvasRunScheduler, type RunGraph } from "./canvas-run-scheduler";
import type { AgentRunRegistry } from "./agent-run-registry";
import type { GraphRunStore } from "./graph-run-store";
import { createRunSlotPool, sharedRunSlotPool, type RunSlotPool } from "./graph-run-slots";
import {
  applyGateBlock,
  applyNodeCompletion,
  buildGraphRunRecord,
  graphRunSpend,
  initCheckpoint,
  type GraphRunCheckpoint,
} from "./graph-run-record";

export interface GraphRunPersistence {
  store: GraphRunStore;
  projectId: string;
  now: () => number;
  idGen?: () => string;
  workflowId?: string;
}

export type GraphRunErrorReason = "empty" | "cycle" | "missing-runner";

export interface GraphRunCallbacks {
  /** A run could not start or continue: no nodes, a cycle/stuck graph, or missing live node runners. */
  onError?: (reason: GraphRunErrorReason, nodeIds?: string[]) => void;
  /** The run stopped: every node finished, or it paused at its budget cap with nothing in flight. */
  onSettled?: () => void;
}

/** Resume an interrupted run: its id + the checkpoint to seed already-done nodes from. */
export interface GraphRunResume {
  graphRunId: string;
  checkpoint: GraphRunCheckpoint;
}

export interface GraphRunOptions {
  /**
   * Gives this run a PRIVATE limit, isolated from every other run. Omit it (the app does) and the
   * run draws from {@link sharedRunSlotPool}, so all runs together stay under one host-derived
   * limit (see `resolveMaxConcurrentRuns`). Every dispatch is a real PTY plus a real CLI process.
   */
  maxConcurrent?: number;
  /** The pool to draw slots from. Wins over `maxConcurrent`. */
  slotPool?: RunSlotPool;
  /** Title + goal handed to each dispatched node (a live agent types it into its terminal). */
  run?: { title: string; brief: string };
  /**
   * USD limit on the run's known spend (see `graphRunSpend`). Once reached, nothing new is
   * dispatched; steps already running finish, then the run settles as `paused`.
   */
  budgetCap?: number;
}

export interface GraphRunSession {
  graphRunId: string | null;
  /**
   * Stops new dispatches; steps already running finish and are recorded, then the run settles as
   * `paused` (resumable). The same path as the budget cap.
   */
  pause(): void;
  /**
   * Stops the run for good: records it `cancelled` and settles now. Steps already running are left
   * to finish on their own — a PTY is never killed — and their results are ignored.
   */
  abort(): void;
  dispose(): void;
}

/**
 * Drives one graph run end-to-end and (when persistence is supplied) checkpoints
 * its progress so it survives a reload. Pass `resume` to continue an interrupted
 * run: completed nodes are seeded into the scheduler and never re-dispatched
 * (0 wasted tokens). React-free so the orchestration is unit testable.
 *
 * The scheduler decides what is *allowed* to run; the slot pool decides how many run at once, so a
 * wide graph queues its overflow instead of opening one agent process per root in a single tick.
 * The pool is shared by every run in the app, so two runs never add up to more than the limit.
 */
export function startGraphRunSession(
  graph: RunGraph,
  registry: AgentRunRegistry,
  callbacks: GraphRunCallbacks = {},
  persistence?: GraphRunPersistence,
  resume?: GraphRunResume,
  options: GraphRunOptions = {},
): GraphRunSession | null {
  if (graph.nodeIds.length === 0) {
    callbacks.onError?.("empty");
    return null;
  }
  const seed = resume ? Object.keys(resume.checkpoint.completed) : [];
  const scheduler = new CanvasRunScheduler(graph.nodeIds, graph.deps, seed);
  const roots = scheduler.start();

  // Nothing left to run (resuming an already-finished run): settle immediately.
  if (scheduler.isDone()) {
    if (resume && persistence) {
      void persistence.store.update(resume.graphRunId, resume.checkpoint, persistence.now());
    }
    callbacks.onSettled?.();
    return { graphRunId: resume?.graphRunId ?? null, pause: () => {}, abort: () => {}, dispose: () => {} };
  }
  if (roots.length === 0) {
    callbacks.onError?.("cycle");
    return null;
  }

  const pendingNodeIds = graph.nodeIds.filter((id) => !seed.includes(id));
  const missingRunnerIds = pendingNodeIds.filter((id) => !registry.has(id));
  if (missingRunnerIds.length > 0) {
    callbacks.onError?.("missing-runner", missingRunnerIds);
    return null;
  }

  let graphRunId = resume?.graphRunId ?? null;
  // Kept even without persistence: the budget cap reads the spend off it.
  let checkpoint = resume?.checkpoint ?? initCheckpoint(graph);
  // Store writes run one after another, and "settled" waits for the last one. Without the chain,
  // the caller's reload after settle raced the final write and read the run back as still running
  // (a finished Run Node card showed "Interrupted 1/2").
  let writes: Promise<void> = Promise.resolve();
  const persist = (write: () => Promise<void>) => {
    writes = writes.then(write).catch(() => undefined);
  };
  const overBudget = () => {
    if (options.budgetCap === undefined) return false;
    return (graphRunSpend(checkpoint).costUsd ?? 0) >= options.budgetCap;
  };
  const settleAfterWrites = () => {
    if (!persistence) {
      callbacks.onSettled?.();
      return;
    }
    void writes.then(() => callbacks.onSettled?.());
  };
  if (!resume && persistence) {
    const record = buildGraphRunRecord({
      projectId: persistence.projectId,
      graph,
      now: persistence.now(),
      id: persistence.idGen?.(),
      workflowId: persistence.workflowId,
    });
    graphRunId = record.id;
    checkpoint = record.checkpoint;
    persist(() => persistence.store.create(record));
  }

  let settled = false;
  let paused = false;
  let unsubscribe = () => {};
  const stop = () => {
    settled = true;
    slots.clear();
    unsubscribe();
  };
  const pause = () => {
    if (persistence && graphRunId) {
      const id = graphRunId;
      persist(() => persistence.store.pause(id, persistence.now()));
    }
    stop();
    settleAfterWrites();
  };
  const fail = (reason: GraphRunErrorReason, nodeIds: string[]) => {
    if (settled) return;
    if (persistence && graphRunId) {
      const id = graphRunId;
      persist(() => persistence.store.finalize(id, "error", persistence.now()));
    }
    stop();
    callbacks.onError?.(reason, nodeIds);
    settleAfterWrites();
  };
  const dispatch = (nodeId: string) => {
    const upstreamIds = graph.deps.filter((d) => d.to === nodeId).map((d) => d.from);
    const dispatched = registry.run(nodeId, { graphRunId, upstreamIds, ...(options.run ? { run: options.run } : {}) });
    if (!dispatched) fail("missing-runner", [nodeId]);
    return dispatched;
  };
  const pool = options.slotPool
    ?? (options.maxConcurrent === undefined ? sharedRunSlotPool() : createRunSlotPool(options.maxConcurrent));
  const slots = pool.lease(dispatch);

  const members = new Set(graph.nodeIds);
  unsubscribe = registry.subscribeResults((id, ok, result) => {
    // Every session hears every result; another run's step must not land in this checkpoint.
    if (!members.has(id)) return;
    // A Critic Node that failed its verdict closes a gate: block its descendants BEFORE
    // completing it, so they are never released (N4). Order matters — completing first would
    // release them before the block lands.
    const blockedIds = result?.gate === "fail" ? scheduler.block(id) : [];
    const released = scheduler.complete(id);
    checkpoint = applyNodeCompletion(checkpoint, id, result ?? {
      outcome: ok ? "completed" : "error",
      sessionId: null,
      nodeRunId: "",
    });
    if (blockedIds.length > 0) checkpoint = applyGateBlock(checkpoint, blockedIds);
    if (persistence && graphRunId) {
      const [runId, next] = [graphRunId, checkpoint];
      persist(() => persistence.store.update(runId, next, persistence.now()));
    }
    // Before the slot is freed: the node queued behind it must not start once the cap is reached.
    if (!paused && overBudget()) {
      paused = true;
      slots.dropQueued();
    }
    // Free this node's slot before submitting: whatever was queued behind it may start before the
    // nodes this completion releases, which keeps the wait FIFO.
    slots.release(id);
    if (!paused) released.forEach((nodeId) => slots.submit(nodeId));
    if (settled) return; // a dispatch inside the submits above failed the run
    if (scheduler.isDone()) {
      stop();
      settleAfterWrites();
      return;
    }
    if (paused) {
      if (slots.inFlight() === 0) pause();
      return;
    }
    // Only a graph with nothing running and nothing waiting for a slot can be genuinely stuck.
    // Without that guard a normal fan-in (sibling still running) or a node merely queued behind
    // the concurrency limit reads as a dependency cycle.
    if (released.length === 0 && slots.inFlight() === 0 && slots.queued() === 0 && scheduler.hasCycle()) {
      fail("cycle", scheduler.pending());
    }
  });

  // Resumed without enough headroom: stop again before anything starts.
  if (overBudget()) pause();
  else roots.forEach((nodeId) => slots.submit(nodeId));
  return settled ? null : {
    graphRunId,
    pause: () => {
      if (settled || paused) return;
      paused = true;
      slots.dropQueued();
      if (slots.inFlight() === 0) pause();
    },
    abort: () => {
      if (settled) return;
      if (persistence && graphRunId) {
        const id = graphRunId;
        persist(() => persistence.store.finalize(id, "cancelled", persistence.now()));
      }
      stop();
      settleAfterWrites();
    },
    dispose: () => { slots.clear(); unsubscribe(); },
  };
}
