import type { AgentNodeStatus } from "../types/canvas";
import type { PlanStep } from "./plan-md-parser";
import { resolveStepAgentId, type OwnerBindings } from "./plan-owner";
import type { AgentStatusSnapshot } from "./agent-status-registry";

export type PlanStepStatus = "pending" | "running" | "done" | "failed";

const AGENT_TO_STEP: Record<AgentNodeStatus, PlanStepStatus> = {
  idle: "pending",
  connecting: "running",
  running: "running",
  // Still in progress: the work has not failed, and it is certainly not done — it is waiting on
  // a human. `failed` would mark the step red and invite a retry that is not what is needed.
  "needs-you": "running",
  completed: "done",
  error: "failed",
  stalled: "failed",
};

/** A step's status: its resolved owner agent's live status if present, else manual done/pending. */
export function stepStatus(
  step: PlanStep,
  roster: readonly AgentStatusSnapshot[],
  bindings?: OwnerBindings,
): PlanStepStatus {
  const agentId = resolveStepAgentId(step.owner, roster, bindings);
  const live = agentId ? roster.find((r) => r.id === agentId)?.status : undefined;
  if (live) return AGENT_TO_STEP[live];
  return step.done ? "done" : "pending";
}

export interface PlanProgress {
  done: number;
  total: number;
  ratio: number;
}

export function planProgress(
  steps: PlanStep[],
  roster: readonly AgentStatusSnapshot[],
  bindings?: OwnerBindings,
): PlanProgress {
  const done = steps.filter((s) => stepStatus(s, roster, bindings) === "done").length;
  return { done, total: steps.length, ratio: steps.length === 0 ? 0 : done / steps.length };
}
