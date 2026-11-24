import { isTauri } from "@/lib/tauri/runtime";
import { codecanvasListAgentRuns, codecanvasAppendAgentRun } from "@/lib/tauri/codecanvas";
import type { AgentRunRecord } from "./agent-run-record";

export const MAX_RUNS_PER_AGENT = 20;

export interface AgentRunStore {
  /** Runs for a canvas node, newest first. */
  list(agentId: string): Promise<AgentRunRecord[]>;
  append(record: AgentRunRecord): Promise<void>;
}

/** SQLite-backed trace store (production) — survives reload for cross-session audit. */
export function createTauriAgentRunStore(): AgentRunStore {
  return {
    list: (agentId) => codecanvasListAgentRuns(agentId),
    append: (record) => codecanvasAppendAgentRun(record),
  };
}

/**
 * Session-scoped trace store. The interface is the seam for a future SQLite
 * adapter (mirror codecanvas_agents) so durability is a drop-in, not a rewrite.
 */
export function createInMemoryAgentRunStore(): AgentRunStore {
  const byAgent = new Map<string, AgentRunRecord[]>();
  return {
    async list(agentId) {
      return [...(byAgent.get(agentId) ?? [])];
    },
    async append(record) {
      const next = [record, ...(byAgent.get(record.agentId) ?? [])].slice(0, MAX_RUNS_PER_AGENT);
      byAgent.set(record.agentId, next);
    },
  };
}

/** Process-wide trace store — SQLite in the desktop app, volatile in browser/tests. */
export const agentRunStore: AgentRunStore = isTauri()
  ? createTauriAgentRunStore()
  : createInMemoryAgentRunStore();
