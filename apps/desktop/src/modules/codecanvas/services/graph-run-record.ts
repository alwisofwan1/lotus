import { descendantsOf, type RunDependency, type RunGraph } from "./canvas-run-scheduler";
import type { AgentRunUsage, RunOutcome } from "./agent-run-record";
import type { FactoryChiefLog, FactoryIntake, FactoryProgress, FactoryPrWatch, FactoryTicket } from "@/lib/tauri/graph-run";

/**
 * `paused` = stopped at its budget cap with steps left; `waiting` = a Factory Run waits for the
 * user's answers or spec approval. Neither is over, so `endedAt` stays null.
 */
export type GraphRunStatus = "running" | "paused" | "waiting" | "completed" | "error" | "cancelled";

/** Result of one node-run within a graph run (links back to its AgentRunRecord). */
export interface GraphRunNodeResult {
  outcome: RunOutcome;
  sessionId: string | null;
  nodeRunId: string;
  /** For a Critic Node: its boolean verdict. "fail" closes the gate (blocks downstream). */
  gate?: "pass" | "fail";
  /** Token/cost accounting mirrored from the node run for graph-level observability. */
  usage?: AgentRunUsage | null;
  /** Rust engine only: what the step wants shown, e.g. a Factory Run's draft PR URL. */
  detail?: string;
}

export interface GraphRunCheckpoint {
  nodeIds: string[];
  deps: RunDependency[];
  completed: Record<string, GraphRunNodeResult>;
  failed: string[];
  /**
   * What failed steps spent — a Critic that says fail or an agent that errors still cost money, and
   * the budget cap must see it. Only steps that reported usage; absent on checkpoints saved before #76.
   */
  failedUsage?: Record<string, AgentRunUsage>;
  /** Rust engine only: why each failed step failed, e.g. the gate output of a red Check. */
  failedDetail?: Record<string, string>;
  pending: string[];
  /** Downstream nodes gated off by a failed Critic — terminal, never dispatched this run. */
  blocked: string[];
  /** Set when the Rust engine (`lotus-graph-run`, ADR-0049) owns the run; absent on TS runs. */
  engine?: GraphRunEngineMeta;
}

/** What the Rust engine keeps on its runs so it can resume them with no UI. */
export interface GraphRunEngineMeta {
  kind: "rust";
  /** USD, whole cents. */
  budgetCap?: number;
  run?: { title: string; brief: string };
  /** Why the engine ended the run as `error` without a step failing (cycle, missing runner). */
  error?: string;
  /** Factory crash hold; ordinary budget/intake actions must not resume it. */
  recovery?: string;
  /** Set on a Factory Run: the ticket it turns into a draft PR. */
  factory?: FactoryTicket;
  /** Where a Factory Run is inside its step; absent on runs made before it was saved. */
  progress?: FactoryProgress;
  /** How a finished Factory Run's draft PR ended, once the reaper saw it; absent while it is open. */
  pr?: "merged" | "closed";
  /** A Factory Run's questions, answers and spec; absent until the spec agent first ran. */
  intake?: FactoryIntake;
  /** What the Chief of Staff noticed about this run; absent until it first did (ADR-0056). */
  chief?: FactoryChiefLog;
  /** The Factory PR as the Chief of Staff last saw it; absent until its first look (CoS 4). */
  prWatch?: FactoryPrWatch;
}

/** A run the Rust engine drives: it resumes it itself, so the TS engine must never pick it up. */
export function isRustOwnedRun(record: GraphRunRecord): boolean {
  return record.checkpoint.engine?.kind === "rust";
}

export interface GraphRunRecord {
  id: string;
  projectId: string;
  /** Links a graph run back to the Swarm Workflow definition that launched it. */
  workflowId?: string;
  status: GraphRunStatus;
  checkpoint: GraphRunCheckpoint;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `graphrun-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

/** Fresh checkpoint for a graph: every node pending, nothing run yet. */
export function initCheckpoint(graph: RunGraph): GraphRunCheckpoint {
  return {
    nodeIds: [...graph.nodeIds],
    deps: graph.deps.map((d) => ({ ...d })),
    completed: {},
    failed: [],
    pending: [...graph.nodeIds],
    blocked: [],
  };
}

/**
 * Closes a gate: a failed Critic's downstream descendants are moved out of `pending` into
 * `blocked` — terminal for this run. Returns a new checkpoint (never mutates). Defensive for
 * pre-N4 checkpoints that lack `blocked`.
 */
export function applyGateBlock(checkpoint: GraphRunCheckpoint, blockedIds: string[]): GraphRunCheckpoint {
  if (blockedIds.length === 0) return checkpoint;
  const toBlock = new Set(blockedIds);
  const priorBlocked = checkpoint.blocked ?? [];
  return {
    ...checkpoint,
    pending: checkpoint.pending.filter((id) => !toBlock.has(id)),
    blocked: [...new Set([...priorBlocked, ...blockedIds])],
  };
}

/**
 * Records a node-run result, moving the node out of `pending` into `completed`
 * (success) or `failed` (error/stopped). Returns a new checkpoint — never mutates.
 */
export function applyNodeCompletion(
  checkpoint: GraphRunCheckpoint,
  nodeId: string,
  result: GraphRunNodeResult,
): GraphRunCheckpoint {
  const pending = checkpoint.pending.filter((id) => id !== nodeId);
  if (result.outcome === "completed") {
    return { ...checkpoint, pending, completed: { ...checkpoint.completed, [nodeId]: result } };
  }
  const failed = checkpoint.failed.includes(nodeId) ? checkpoint.failed : [...checkpoint.failed, nodeId];
  if (!result.usage) return { ...checkpoint, pending, failed };
  return { ...checkpoint, pending, failed, failedUsage: { ...checkpoint.failedUsage, [nodeId]: result.usage } };
}

/**
 * Time-travel: rebuild a checkpoint that re-runs `fromNodeId` and everything
 * downstream, while keeping upstream results cached (so ancestors aren't re-run).
 */
export function replayCheckpoint(checkpoint: GraphRunCheckpoint, fromNodeId: string): GraphRunCheckpoint {
  const reset = new Set([fromNodeId, ...descendantsOf(fromNodeId, checkpoint.deps)]);
  const completed: Record<string, GraphRunNodeResult> = {};
  for (const [id, result] of Object.entries(checkpoint.completed)) {
    if (!reset.has(id)) completed[id] = result;
  }
  const failed = checkpoint.failed.filter((id) => !reset.has(id));
  const failedUsage = Object.fromEntries(Object.entries(checkpoint.failedUsage ?? {}).filter(([id]) => !reset.has(id)));
  // Blocked nodes inside the reset subgraph become runnable again; those outside stay gated.
  const blocked = (checkpoint.blocked ?? []).filter((id) => !reset.has(id));
  const pending = checkpoint.nodeIds
    .filter((id) => !(id in completed) && !failed.includes(id) && !blocked.includes(id))
    .sort();
  return {
    nodeIds: [...checkpoint.nodeIds], deps: checkpoint.deps.map((d) => ({ ...d })), completed, failed,
    ...(Object.keys(failedUsage).length > 0 ? { failedUsage } : {}),
    pending, blocked,
  };
}

export interface GraphRunSummary {
  total: number;
  done: number;
  failed: number;
  /** Nodes gated off by a failed Critic. */
  blocked: number;
  durationMs: number | null;
  status: GraphRunStatus;
}

/** At-a-glance health of a run: node counts + wall-clock duration. */
export function summarizeGraphRun(record: GraphRunRecord): GraphRunSummary {
  return {
    total: record.checkpoint.nodeIds.length,
    done: Object.keys(record.checkpoint.completed).length,
    failed: record.checkpoint.failed.length,
    blocked: (record.checkpoint.blocked ?? []).length,
    durationMs: record.endedAt != null ? record.endedAt - record.startedAt : null,
    status: record.status,
  };
}

export interface GraphRunSpend {
  /** Sum of the known costs of finished steps; null when no finished step reported one. */
  costUsd: number | null;
  /** Finished steps that reported no cost — the budget cap cannot see them. */
  unknownCostSteps: number;
}

/**
 * What a run has spent so far, from the results its checkpoint kept: completed steps, plus failed
 * steps that reported usage. A failed step without usage is not counted as "cost unknown" — a
 * rejected Human Gate fails that way and costs nothing.
 */
export function graphRunSpend(checkpoint: GraphRunCheckpoint): GraphRunSpend {
  const costs = Object.values(checkpoint.completed).map((r) => r.usage?.costUsd);
  const failedCosts = Object.values(checkpoint.failedUsage ?? {}).map((u) => u.costUsd);
  const known = [...costs, ...failedCosts].filter((c): c is number => typeof c === "number");
  return {
    costUsd: known.length > 0 ? known.reduce((a, b) => a + b, 0) : null,
    unknownCostSteps: costs.length - costs.filter((c) => typeof c === "number").length
      + failedCosts.filter((c) => typeof c !== "number").length,
  };
}

/** Terminal once nothing is pending: error if any node failed or was gated off, else completed. */
export function deriveGraphRunStatus(checkpoint: GraphRunCheckpoint): GraphRunStatus {
  if (checkpoint.pending.length > 0) return "running";
  return checkpoint.failed.length > 0 || (checkpoint.blocked ?? []).length > 0 ? "error" : "completed";
}

export function buildGraphRunRecord(input: {
  projectId: string;
  graph: RunGraph;
  now: number;
  id?: string;
  workflowId?: string;
}): GraphRunRecord {
  return {
    id: input.id ?? newId(),
    projectId: input.projectId,
    workflowId: input.workflowId,
    status: "running",
    checkpoint: initCheckpoint(input.graph),
    startedAt: input.now,
    endedAt: null,
    updatedAt: input.now,
  };
}
