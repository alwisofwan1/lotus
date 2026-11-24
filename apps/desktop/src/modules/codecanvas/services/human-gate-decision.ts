import { agentRunRegistry, type AgentRunRegistry } from "./agent-run-registry";
import type { HumanGateNodePatch } from "../types/canvas";

export type HumanGateDecision = "approve" | "reject";

/** The patch that starts a gate's wait; `waitingSince` is what the Run Node's Decide timer counts from. */
export function humanGateWaitPatch(now: number): HumanGateNodePatch {
  return { status: "waiting", waitingSince: now };
}

/**
 * One decision on a waiting Human Gate. The gate's own Approve / Reject and the Run Node's decision
 * card both go through here, so the two can never drift apart: the node's status and the result the
 * graph run sees are written together.
 */
export function decideHumanGate(
  gateId: string,
  decision: HumanGateDecision,
  patchGate: (patch: HumanGateNodePatch) => void,
  registry: AgentRunRegistry = agentRunRegistry,
  now: number = Date.now(),
): void {
  const approved = decision === "approve";
  patchGate({ status: approved ? "approved" : "rejected", waitingSince: undefined });
  registry.reportResult(gateId, approved, {
    outcome: approved ? "completed" : "error",
    sessionId: null,
    nodeRunId: `human-gate-${gateId}-${now}`,
    gate: approved ? "pass" : "fail",
  });
}
