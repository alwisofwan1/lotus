import type { AgentStatusSnapshot } from "./agent-status-registry";
import type { CanvasTaskStatus } from "../types/canvas";

/**
 * Rolls a task's status up from its dispatched agents: every agent terminal
 * (completed or errored) → in-review; any still running → in-progress. Returns
 * the new status, or null when nothing should change (no agents, not yet in the
 * roster, no transition, already past review, or blocked — a FAIL verdict is a person's call, and
 * the agents being done is exactly what it was reviewing).
 */
export function rollUpTaskStatus(
  dispatchedAgentIds: string[],
  roster: AgentStatusSnapshot[],
  current: CanvasTaskStatus,
): CanvasTaskStatus | null {
  if (dispatchedAgentIds.length === 0) return null;
  const ids = new Set(dispatchedAgentIds);
  const mine = roster.filter((r) => ids.has(r.id));
  if (mine.length === 0) return null;

  const allTerminal = mine.every((r) => r.status === "completed" || r.status === "error");
  if (allTerminal) return current === "in-review" || current === "complete" || current === "blocked" ? null : "in-review";

  const anyActive = mine.some((r) => r.status === "running" || r.status === "connecting");
  if (anyActive && current === "todo") return "in-progress";
  return null;
}
