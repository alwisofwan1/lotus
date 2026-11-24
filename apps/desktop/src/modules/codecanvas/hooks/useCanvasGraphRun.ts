"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunGraph } from "../services/canvas-run-scheduler";
import { agentRunRegistry, type AgentRunRegistry } from "../services/agent-run-registry";
import { graphRunStore, type GraphRunStore } from "../services/graph-run-store";
import { startGraphRunSession, type GraphRunOptions, type GraphRunSession } from "../services/graph-run-session";
import {
  buildGraphRunRecord,
  deriveGraphRunStatus,
  isRustOwnedRun,
  replayCheckpoint,
  summarizeGraphRun,
  type GraphRunRecord,
  type GraphRunSummary,
} from "../services/graph-run-record";

export interface UseCanvasGraphRunOptions {
  /** When set, the run is checkpointed under this project so it can be resumed. */
  projectId?: string;
  store?: GraphRunStore;
  workflowId?: string;
  /**
   * How many agent nodes may run at once. Each one is a real PTY plus a real CLI process, so a
   * wide graph queues its overflow instead of opening them all at once. Omit to derive from the
   * host — see `resolveMaxConcurrentRuns`.
   */
  maxConcurrent?: number;
  /** Title + goal handed to each dispatched node (live agents need a task to type in). */
  run?: { title: string; brief: string };
  /** Names a node in error messages; defaults to its id. */
  nodeLabel?: (nodeId: string) => string;
  /** USD limit per run; reaching it pauses the run (see `GraphRunOptions.budgetCap`). */
  budgetCap?: number;
}

export interface UseCanvasGraphRunResult {
  running: boolean;
  error: string | null;
  run: () => void;
  /** An interrupted or budget-paused run for this project, if one is recoverable. */
  resumable: GraphRunRecord | null;
  /** Continues `resumable` from its checkpoint, skipping completed nodes. */
  resume: () => void;
  /** {@link resume} under `budgetCap` instead of the option's — the cap was just raised. */
  resumeWithBudget: (budgetCap: number) => void;
  /** Re-runs `nodeId` and everything downstream, reusing cached upstream results. */
  replayFrom: (nodeId: string) => void;
  /**
   * {@link replayFrom}, held until the live session settles (right away when none is running). The
   * replay is based on the record that session finalized.
   */
  replayFromWhenSettled: (nodeId: string) => void;
  /** Stops new steps of the live run; it settles as paused once the running steps finish. */
  pause: () => void;
  /** True between {@link pause} and the run settling. */
  pausing: boolean;
  /**
   * Ends the run for good, recorded as `cancelled`: the live session, or else the paused/interrupted
   * record {@link resumable} points at. Running steps finish on their own; their results are ignored.
   */
  abort: () => void;
  /** True when a prior run exists to replay against (enables "re-run from here"). */
  replayable: boolean;
  /** Most recent persisted run, used by the production inspector. */
  latestRun: GraphRunRecord | null;
  /** At-a-glance health of the most recent run (counts + duration), if any. */
  lastSummary: GraphRunSummary | null;
}

/**
 * Executes a run graph: spawns dependency-free agents, then releases each
 * dependent as its upstreams complete. `buildGraph` is resolved at run time so
 * both the edge-based graph run and the plan-based run reuse one orchestrator.
 */
export function useCanvasGraphRun(
  buildGraph: () => RunGraph,
  registry: AgentRunRegistry = agentRunRegistry,
  emptyMessage = "Add at least one agent to run.",
  options: UseCanvasGraphRunOptions = {},
): UseCanvasGraphRunResult {
  const { projectId, store, workflowId, maxConcurrent, run: runInfo, nodeLabel, budgetCap } = options;
  const runTitle = runInfo?.title;
  const runBrief = runInfo?.brief;
  const sessionOptions = useMemo(
    () => ({
      maxConcurrent,
      ...(runTitle !== undefined && runBrief !== undefined ? { run: { title: runTitle, brief: runBrief } } : {}),
      ...(budgetCap !== undefined ? { budgetCap } : {}),
    }),
    [maxConcurrent, runTitle, runBrief, budgetCap],
  );
  const labelRef = useRef(nodeLabel);
  useEffect(() => { labelRef.current = nodeLabel; }, [nodeLabel]);
  const [running, setRunning] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<GraphRunRecord | null>(null);
  const [latestRun, setLatestRun] = useState<GraphRunRecord | null>(null);
  const sessionRef = useRef<GraphRunSession | null>(null);
  const queuedReplayRef = useRef<string | null>(null);
  // `settle` starts a queued replay, and a replay settles through `settle`: the ref breaks the cycle.
  const startReplayRef = useRef<(base: GraphRunRecord, nodeId: string) => void>(() => {});

  useEffect(() => () => sessionRef.current?.dispose(), []);

  // Reloads the run list: an interrupted run (status still "running") or a paused one to resume,
  // and the latest run (any status) for replay + the at-a-glance summary.
  // Only this controller's own runs: a Run Node sees its `workflowId`, the canvas-wide controller
  // sees runs without one — so one run's record never becomes another's resume or replay base.
  const loadRuns = useCallback(
    () => (projectId
      ? (store ?? graphRunStore).list(projectId).then((runs) => runs.filter((r) => (r.workflowId ?? null) === (workflowId ?? null)))
      : Promise.resolve<GraphRunRecord[]>([])),
    [projectId, store, workflowId],
  );
  const applyRuns = useCallback((runs: GraphRunRecord[]) => {
    setLatestRun(runs[0] ?? null);
    // A Rust-owned run resumes on its own (ADR-0049); resuming it here too would run steps twice.
    setResumable(runs.find((r) => (r.status === "running" || r.status === "paused") && !isRustOwnedRun(r)) ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadRuns().then((runs) => { if (!cancelled) applyRuns(runs); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [loadRuns, applyRuns]);

  // While a graph is running, poll the durable checkpoint so the inspector shows
  // live progress without introducing a store subscription API.
  useEffect(() => {
    if (!running || !projectId) return;
    let cancelled = false;
    const refresh = () => void loadRuns().then((runs) => { if (!cancelled) applyRuns(runs); }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 750);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [running, projectId, loadRuns, applyRuns]);

  const onError = useCallback((reason: "empty" | "cycle" | "missing-runner", nodeIds?: string[]) => {
    if (reason === "empty") {
      setError(emptyMessage);
      return;
    }
    const names = nodeIds?.map((id) => labelRef.current?.(id) ?? id);
    if (reason === "missing-runner") {
      setError(`Cannot start graph — missing live node runner${names?.length === 1 ? "" : "s"}: ${names?.join(", ") || "unknown"}.`);
      return;
    }
    setError(names?.length
      ? `Cycle detected — graph is stuck behind: ${names.join(", ")}.`
      : "Cycle detected — no agent can start.");
  }, [emptyMessage]);

  const begin = useCallback((session: GraphRunSession | null) => {
    if (!session) return;
    sessionRef.current = session;
    setError(null);
    setRunning(true);
    setResumable(null);
  }, []);

  const persistence = useCallback(
    () => (projectId ? { store: store ?? graphRunStore, projectId, now: () => Date.now(), workflowId } : undefined),
    [projectId, store, workflowId],
  );

  const settle = useCallback(() => {
    sessionRef.current = null;
    setRunning(false);
    setPausing(false);
    const replayNodeId = queuedReplayRef.current;
    queuedReplayRef.current = null;
    // Pull the just-finalized run into the summary; a queued replay starts from that same record.
    void loadRuns().then((runs) => {
      applyRuns(runs);
      if (replayNodeId && runs[0]) startReplayRef.current(runs[0], replayNodeId);
    }).catch(() => undefined);
  }, [loadRuns, applyRuns]);

  const run = useCallback(() => {
    if (running) return;
    begin(startGraphRunSession(buildGraph(), registry, { onError, onSettled: settle }, persistence(), undefined, sessionOptions));
  }, [running, registry, buildGraph, onError, settle, persistence, begin, sessionOptions]);

  const resumeWith = useCallback((options: GraphRunOptions) => {
    if (running || !resumable) return;
    const graph: RunGraph = { nodeIds: resumable.checkpoint.nodeIds, deps: resumable.checkpoint.deps };
    begin(startGraphRunSession(graph, registry, { onError, onSettled: settle }, persistence(), {
      graphRunId: resumable.id,
      checkpoint: resumable.checkpoint,
    }, options));
  }, [running, resumable, registry, onError, settle, persistence, begin]);
  const resume = useCallback(() => resumeWith(sessionOptions), [resumeWith, sessionOptions]);
  const resumeWithBudget = useCallback(
    (cap: number) => resumeWith({ ...sessionOptions, budgetCap: cap }),
    [resumeWith, sessionOptions],
  );

  const startReplay = useCallback((base: GraphRunRecord, nodeId: string) => {
    const graph: RunGraph = { nodeIds: base.checkpoint.nodeIds, deps: base.checkpoint.deps };
    const checkpoint = replayCheckpoint(base.checkpoint, nodeId);
    const p = persistence();
    // A replay is a fresh run record (the prior run stays as audit history).
    const record = p
      ? { ...buildGraphRunRecord({ projectId: p.projectId, graph, now: p.now(), workflowId: p.workflowId }), checkpoint, status: deriveGraphRunStatus(checkpoint) }
      : null;
    if (p && record) void p.store.create(record);
    begin(startGraphRunSession(graph, registry, { onError, onSettled: settle }, p, {
      graphRunId: record?.id ?? "replay",
      checkpoint,
    }, sessionOptions));
  }, [registry, onError, settle, persistence, begin, sessionOptions]);
  useEffect(() => { startReplayRef.current = startReplay; }, [startReplay]);

  const replayFrom = useCallback((nodeId: string) => {
    if (running || !latestRun) return;
    startReplay(latestRun, nodeId);
  }, [running, latestRun, startReplay]);

  const replayFromWhenSettled = useCallback((nodeId: string) => {
    if (sessionRef.current) queuedReplayRef.current = nodeId;
    else replayFrom(nodeId);
  }, [replayFrom]);

  const pause = useCallback(() => {
    if (!sessionRef.current) return;
    // Before the call: with nothing in flight the session settles inside it, and settle clears this.
    setPausing(true);
    sessionRef.current.pause();
  }, []);

  const abort = useCallback(() => {
    if (sessionRef.current) {
      queuedReplayRef.current = null;
      sessionRef.current.abort();
      return;
    }
    if (!resumable || !projectId) return;
    const id = resumable.id;
    setResumable(null);
    void (store ?? graphRunStore).finalize(id, "cancelled", Date.now())
      .then(() => loadRuns()).then(applyRuns).catch(() => undefined);
  }, [resumable, projectId, store, loadRuns, applyRuns]);

  return {
    running, error, run, resumable, resume, resumeWithBudget, replayFrom, replayFromWhenSettled,
    pause, pausing, abort,
    replayable: !!latestRun,
    latestRun,
    lastSummary: latestRun ? summarizeGraphRun(latestRun) : null,
  };
}
