import type { CanvasWireKind } from "./canvas-wire-style";

/** Execution-meaningful edge kinds, in cycle order. A graph run reads these. */
export const EXECUTION_EDGE_KINDS = ["triggers", "orchestrates"] as const;
export type ExecutionEdgeKind = (typeof EXECUTION_EDGE_KINDS)[number];

/** Agent workflow wires are visible workflow semantics, but only execution kinds trigger graph runs. */
export const AGENT_WORKFLOW_KINDS = ["context", "triggers", "orchestrates", "data-flow", "agent-link"] as const;
export type AgentWorkflowKind = (typeof AGENT_WORKFLOW_KINDS)[number];

export const EDGE_KIND_LABEL: Partial<Record<CanvasWireKind, string>> = {
  context: "context",
  triggers: "triggers",
  orchestrates: "orchestrates",
  "data-flow": "data",
  "agent-link": "link",
};

export function isAgentWorkflowKind(kind: string): kind is AgentWorkflowKind {
  return (AGENT_WORKFLOW_KINDS as readonly string[]).includes(kind);
}

export function isSemanticEdgeKind(kind: string): kind is AgentWorkflowKind {
  return isAgentWorkflowKind(kind);
}

/**
 * Default meaning for a freshly drawn wire, from the node types it joins.
 * Any edge touching an agent is an agent-workflow wire; other edges stay plain.
 */
export function inferEdgeKind(sourceType?: string, targetType?: string): CanvasWireKind {
  if (sourceType === "note" && targetType === "agent") return "context";
  // Shared Context Bus: an agent writes its artifact to a Context Node (data-flow),
  // a Context Node feeds its artifacts to an agent (context).
  if (sourceType === "agent" && targetType === "context") return "data-flow";
  if (sourceType === "context" && targetType === "agent") return "context";
  // Critic gate (N4): a critic runs after the agent it verifies, and gates the agent after it.
  // Both are execution edges so the run graph treats them as dependencies.
  if (sourceType === "agent" && targetType === "critic") return "triggers";
  if (sourceType === "critic" && targetType === "agent") return "triggers";
  // A review of a review (#112): the second critic waits for the first and reads its verdict.
  if (sourceType === "critic" && targetType === "critic") return "triggers";
  if (targetType === "team" || sourceType === "team") return "triggers";
  if (targetType === "human-gate" || sourceType === "human-gate") return "triggers";
  if (sourceType === "agent" && targetType === "agent") return "triggers";
  if (sourceType === "agent" && targetType === "note") return "data-flow";
  // A File Node says "this file belongs to that agent" (plans/canvas-code, S4). The wire may end on
  // the agent itself or on its terminal / adopted cell.
  if (sourceType === "file" && (targetType === "agent" || targetType === "terminal" || targetType === "host-cell")) return "context";
  if (sourceType === "agent" || targetType === "agent") return "agent-link";
  return "default";
}

/**
 * The kind a saved wire comes back with. A critic → critic wire drawn before #112 was saved as a
 * plain wire and ran nothing; it loads as `triggers`, the meaning a new one gets. Every other saved
 * kind is kept as it is.
 */
export function restoredEdgeKind(saved: string | undefined, sourceType?: string, targetType?: string): CanvasWireKind {
  const kind = (saved ?? "default") as CanvasWireKind;
  return kind === "default" && sourceType === "critic" && targetType === "critic" ? "triggers" : kind;
}

/** Advance an edge through meanings valid for its endpoint types. */
export function cycleEdgeKind(current: CanvasWireKind, sourceType?: string, targetType?: string): CanvasWireKind {
  if (sourceType === "agent" && targetType === "agent") {
    return current === "triggers" ? "orchestrates" : "triggers";
  }
  return inferEdgeKind(sourceType, targetType);
}
