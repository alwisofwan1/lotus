import type { RunGraph } from "./canvas-run-scheduler";
import type { CanvasPlanStep } from "../types/canvas";
import { resolveStepAgentId, type AgentRef, type OwnerBindings } from "./plan-owner";

/**
 * Turns a plan's steps into a linear run chain: each step's owner (resolved to its canvas node id
 * via binding or name) runs once, in first-appearance plan order. Steps without a resolvable owner
 * are skipped. Feeds the same scheduler as the graph run.
 */
export function planAgentChain(
  steps: CanvasPlanStep[],
  roster: readonly AgentRef[],
  bindings?: OwnerBindings,
): RunGraph {
  const nodeIds: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const id = resolveStepAgentId(step.owner, roster, bindings);
    if (id && !seen.has(id)) {
      seen.add(id);
      nodeIds.push(id);
    }
  }
  const deps = nodeIds.slice(1).map((to, i) => ({ from: nodeIds[i], to }));
  return { nodeIds, deps };
}
