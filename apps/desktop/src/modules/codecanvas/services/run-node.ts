import type { Node } from "@xyflow/react";
import { isRunnableNodeType, type RunDependency } from "./canvas-run-scheduler";
import { graphRunSpend, type GraphRunRecord } from "./graph-run-record";
import type { CanvasNodeSize } from "../types/canvas";
import { DEFAULT_RUN_NODE_SIZE } from "./canvas-node-placement";

/**
 * Run Node domain: one Run Node = one graph run over its member nodes (plans/canvas-graph-run).
 * Membership is data on the Run Node (`memberIds`), never React Flow `parentId`. Status is
 * derived from the run record, never stored on the node.
 */

export { DEFAULT_RUN_NODE_SIZE };

/** Gap between a new Run Node and the members it was created from. */
const RUN_NODE_GAP = 40;

/** The workflow id a Run Node's records are filed under. */
export function runNodeWorkflowId(runNodeId: string): string {
  return `run-node:${runNodeId}`;
}

function memberIdsOf(node: Node): string[] {
  const ids = (node.data as { memberIds?: unknown } | undefined)?.memberIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Which of `candidateIds` a new Run Node may own: runnable nodes that exist, and never a node
 * another Run Node already owns — a node is in at most one run.
 */
export function claimRunMembers(nodes: Node[], candidateIds: readonly string[]): string[] {
  const owned = new Set(nodes.filter((n) => n.type === "run").flatMap(memberIdsOf));
  const wanted = new Set(candidateIds);
  return nodes.filter((n) => wanted.has(n.id) && isRunnableNodeType(n.type) && !owned.has(n.id)).map((n) => n.id);
}

/** The current selection's claimable members (see {@link claimRunMembers}). */
export function runMembersFromSelection(nodes: Node[]): string[] {
  return claimRunMembers(nodes, nodes.filter((n) => n.selected).map((n) => n.id));
}

/** Places a new Run Node just above its members' bounding box, left-aligned with it. */
export function runNodePlacement(members: Node[], size: CanvasNodeSize = DEFAULT_RUN_NODE_SIZE): { x: number; y: number } {
  if (members.length === 0) return { x: 0, y: 0 };
  const x = Math.min(...members.map((n) => n.position.x));
  const y = Math.min(...members.map((n) => n.position.y));
  return { x, y: y - size.h - RUN_NODE_GAP };
}

export type RunCardState = "idle" | "running" | "waiting" | "pausing" | "paused" | "interrupted" | "failed" | "done" | "stopped";

/** Which `--canvas-status-*` tone a card state wears. */
export const RUN_CARD_TONE: Record<RunCardState, "idle" | "running" | "blocked" | "error" | "completed"> = {
  idle: "idle",
  running: "running",
  waiting: "blocked",
  pausing: "blocked",
  paused: "blocked",
  interrupted: "blocked",
  failed: "error",
  done: "completed",
  stopped: "idle",
};

export const RUN_CARD_LABEL: Record<RunCardState, string> = {
  idle: "Ready",
  running: "Running",
  waiting: "Waiting on you",
  pausing: "Pausing…",
  paused: "Paused",
  interrupted: "Interrupted",
  failed: "Failed",
  done: "Done",
  stopped: "Stopped",
};

/** A paused run that stopped because its spend reached the cap — Raise cap continues it. */
export function pausedAtBudget(view: Pick<RunCardView, "state" | "costUsd" | "budgetCap">): boolean {
  return view.state === "paused" && view.budgetCap != null && (view.costUsd ?? 0) >= view.budgetCap;
}

/** The status word beside the dot: a pause names its reason when the cap caused it. */
export function runCardLabel(view: Pick<RunCardView, "state" | "costUsd" | "budgetCap">): string {
  return pausedAtBudget(view) ? "Paused · budget" : RUN_CARD_LABEL[view.state];
}

/** USD amount → whole cents. `toFixed(6)` first strips float noise (`0.08 * 1.5 * 100` is 12.000000000000002). */
const toCents = (usd: number) => Number((usd * 100).toFixed(6));

/**
 * A Run Node's budget cap in USD, in whole cents: a positive finite number, anything else (or less
 * than a cent) means no cap. A cap written before caps were kept in cents (`0.113906`) reads as `0.11`.
 */
export function normalizeBudgetCap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const cents = Math.round(toCents(value));
  return cents > 0 ? cents / 100 : undefined;
}

/**
 * The cap Raise cap writes: `max(cap, spent) × 1.5`, rounded UP to whole cents. Scaling the cap
 * alone needed six presses when the spend was 8× the cap (app test of PR #79), because a resume
 * still at or over the cap pauses again before dispatching. From the spend, one press always
 * clears it.
 */
export function raisedBudgetCap(cap: number, spent: number | null): number {
  return Math.ceil(toCents(Math.max(cap, spent ?? 0) * 1.5)) / 100;
}

/** A member Human Gate that is waiting for the user, as the Run Node card decides it. */
export interface RunGateWait {
  gateId: string;
  title: string;
  instructions: string;
  /** Absent on a gate that started waiting before `waitingSince` existed. */
  waitingSince?: number;
}

export interface RunCardView {
  state: RunCardState;
  /** The gate the card decides — the first waiting one in member order — while the state is `waiting`. */
  gate: RunGateWait | null;
  /** How many more member gates are waiting behind `gate`. */
  moreWaiting: number;
  /** How long `gate` has been waiting, when it recorded the start. */
  waitingMs: number | null;
  /** Members that finished (completed or failed). */
  finished: number;
  total: number;
  failed: number;
  costUsd: number | null;
  /** Finished members that reported no cost; the cap does not see them. */
  unknownCostSteps: number;
  budgetCap: number | null;
  elapsedMs: number | null;
}

/**
 * Which member gates are waiting for the user, in member order. `nodeOf` resolves a member id to the
 * node as it is on the board right now.
 */
export function waitingRunGates(memberIds: readonly string[], nodeOf: (id: string) => Node | undefined): RunGateWait[] {
  return memberIds.flatMap((id) => {
    const n = nodeOf(id);
    if (n?.type !== "human-gate") return [];
    const d = n.data as { title?: unknown; instructions?: unknown; status?: unknown; waitingSince?: unknown };
    if (d.status !== "waiting") return [];
    return [{
      gateId: id,
      title: typeof d.title === "string" ? d.title : "Human gate",
      instructions: typeof d.instructions === "string" ? d.instructions : "",
      ...(typeof d.waitingSince === "number" ? { waitingSince: d.waitingSince } : {}),
    }];
  });
}

/**
 * Card view of a Run Node from its latest record. `live` is whether a session is running right
 * now: a record still marked "running" with no live session was cut off (app closed mid-run).
 * A live run with a waiting member gate is `waiting` — the user, not an agent, is what it waits on.
 */
export function runCardView(
  record: GraphRunRecord | null,
  live: boolean,
  memberCount: number,
  now: number,
  waitingGates: readonly RunGateWait[] = [],
  budgetCap: number | null = null,
  pausing = false,
): RunCardView {
  const waiting = live && waitingGates.length > 0;
  const first = waiting ? waitingGates[0] : null;
  const gate = {
    gate: first,
    moreWaiting: waiting ? waitingGates.length - 1 : 0,
    waitingMs: first?.waitingSince !== undefined ? Math.max(0, now - first.waitingSince) : null,
  };
  // A gate still waiting outranks the pause: the user is what the run waits on.
  const liveState: RunCardState = waiting ? "waiting" : pausing ? "pausing" : "running";
  if (!record) {
    return {
      state: live ? liveState : "idle", ...gate,
      finished: 0, total: memberCount, failed: 0, costUsd: null, unknownCostSteps: 0, budgetCap, elapsedMs: null,
    };
  }
  const { checkpoint } = record;
  const state: RunCardState = live
    ? liveState
    : record.status === "paused" ? "paused"
    : record.status === "waiting" ? "waiting"
    : record.status === "running" ? "interrupted"
    : record.status === "error" ? "failed"
    : record.status === "completed" ? "done"
    : "stopped";
  const end = live ? now : record.endedAt ?? record.updatedAt;
  return {
    state,
    ...gate,
    finished: Object.keys(checkpoint.completed).length + checkpoint.failed.length,
    total: checkpoint.nodeIds.length,
    failed: checkpoint.failed.length,
    ...graphRunSpend(checkpoint),
    budgetCap,
    elapsedMs: Math.max(0, end - record.startedAt),
  };
}

/**
 * The member that produced a gate's input — what "Send back" re-runs. Only a gate with exactly one
 * upstream member has an unambiguous author; `null` otherwise.
 */
export function runGateAuthor(gateId: string, memberIds: readonly string[], deps: readonly RunDependency[]): string | null {
  const members = new Set(memberIds);
  const upstream = [...new Set(deps.filter((d) => d.to === gateId && members.has(d.from)).map((d) => d.from))];
  return upstream.length === 1 ? upstream[0] : null;
}

/** `4:12`, `1:02:09` — compact wall-clock for the meta line. */
export function formatRunElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The card's order line, as the run will really dispatch it: "→" = starts after, "+" = starts at
 * the same time. Joining every member with "→" claimed an order no wire gave — two unwired agents
 * ran in parallel under a card that said "Atlas → Lyra".
 */
export function runChainLabel(members: readonly { id: string; label: string }[], deps: readonly RunDependency[]): string {
  const ids = new Set(members.map((m) => m.id));
  const waitsOn = new Map(members.map((m) => [m.id, new Set<string>()]));
  for (const { from, to } of deps) if (ids.has(from) && ids.has(to)) waitsOn.get(to)!.add(from);
  const placed = new Set<string>();
  const levels: string[] = [];
  while (placed.size < members.length) {
    const level = members.filter((m) => !placed.has(m.id) && [...waitsOn.get(m.id)!].every((d) => placed.has(d)));
    // A cycle never resolves: list what is left as one stuck group instead of looping.
    const step = level.length > 0 ? level : members.filter((m) => !placed.has(m.id));
    step.forEach((m) => placed.add(m.id));
    levels.push(step.map((m) => m.label).join(" + "));
  }
  return levels.join(" → ");
}
