export type RunOutcome = "completed" | "error" | "stopped";
export type RunKind = "run" | "reply";

/** Token/cost accounting for one run, from the stream-json `result` event. */
export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface AgentRunRecord {
  id: string;
  /** Canvas node id the run belongs to. */
  agentId: string;
  kind: RunKind;
  outcome: RunOutcome;
  startedAt: number;
  endedAt: number;
  sessionId: string | null;
  /** The graph run that drove this run, when graph-driven (null for manual runs). */
  graphRunId?: string | null;
  /** Token/cost accounting once the run reports a result. */
  usage?: AgentRunUsage | null;
  actions: string[];
  summary?: string;
}

export const MAX_RUN_ACTIONS = 200;

/** Keeps the most recent actions (where the result lives), marking earlier ones as truncated. */
export function capActions(actions: string[], max = MAX_RUN_ACTIONS): string[] {
  if (actions.length <= max) return actions;
  return [`…${actions.length - max} earlier actions`, ...actions.slice(-max)];
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `run-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

export function buildRunRecord(input: Omit<AgentRunRecord, "id" | "actions"> & { actions: string[] }): AgentRunRecord {
  return { ...input, id: newId(), actions: capActions(input.actions) };
}
