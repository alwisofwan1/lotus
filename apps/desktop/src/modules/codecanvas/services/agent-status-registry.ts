import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { AgentNodeStatus } from "../types/canvas";

export interface AgentStatusSnapshot {
  id: string;
  name: string;
  status: AgentNodeStatus;
  /** Globally unique pane id exported to the runner as LOTUS_PANE_ID; defaults to `id` for older callers. */
  hookPaneId?: string;
  /** PTY session id of a live persona — lets the MCP fleet read/dispatch to it (Fase 2). */
  sessionId?: string | null;
  /** Runner's turn ends arrive via an installed CLI hook (see isHookCapableRunner) — such panes
   *  are excluded from the byte-idle fallback entirely. */
  hookCapable?: boolean;
  /** The canvas project this agent belongs to — lets the done-callout channel name the repo when
   *  the finish happens in a project other than the one on screen (cross-project callout). */
  projectId?: string;
  /** Secondary spoken handles, e.g. runner aliases like "Codex" for an agent named "Nova". */
  aliases?: string[];
  /** Runner identity used by the MCP fleet so peers see Codex/Claude/custom truthfully. */
  runner?: AgentRunnerType;
  runnerCommand?: string;
  claudeFamily?: boolean;
  /**
   * Explicit fleet provider label (Phase 4). When set it wins over the runner-derived provider —
   * lets a node report a specific provider (e.g. "custom") the runner mapping can't infer.
   */
  provider?: string;
  /**
   * The runner name as this node's own header prints it — `Claude Code`, `Codex`, `acme`.
   *
   * Not derivable downstream: a custom runner's label is its registry entry's name, resolved
   * here and nowhere else, and `provider` collapses a custom Claude-family runner to "claude"
   * on purpose. Remote clients had no way to print what the desktop prints.
   */
  runnerLabel?: string;
  /** Can the agent receive a dispatch RIGHT NOW? (Phase 4 routing truth; falls back to status.) */
  canReply?: boolean;
  /** Is the agent alive enough to buffer a dispatch until ready? (Phase 4; falls back to status.) */
  canQueue?: boolean;
  /** Does the agent have the Lotus MCP tools wired? (Phase 4; falls back to claudeFamily.) */
  mcpToolsAvailable?: boolean;
  /**
   * When this pane's {@link status} last CHANGED, not when it was last published.
   *
   * Stamped by the registry so a reader can say how long a cell has been the way it is. Without it
   * a resting fleet reads as one or two repeated words with nothing to act on: `quiet · 42m` is
   * worth a look, `quiet · 1m` is not, and the difference is the only thing that makes a row
   * actionable at rest.
   *
   * Stamped HERE rather than derived from the hook pipeline deliberately. The turn registry and the
   * narration facts store both carry timings, but only for hook-capable runners — this works for
   * codex, cursor and custom too, which are precisely the runners the fleet rail was extended to
   * cover. A caller that already knows the stamp (a remote snapshot) may pass its own.
   */
  statusChangedAt?: number;
}

export type AgentStatusListener = (snapshots: AgentStatusSnapshot[]) => void;

export interface AgentStatusRegistry {
  publish(snapshot: AgentStatusSnapshot): void;
  remove(id: string): void;
  list(): AgentStatusSnapshot[];
  subscribe(listener: AgentStatusListener): () => void;
}

/**
 * Live status of every AgentNode on the board, for the Inbox monitoring panel.
 * Nodes publish their status; the inbox subscribes and aggregates. Separate from
 * the run registry (which only coordinates graph execution).
 */
export function createAgentStatusRegistry(now: () => number = Date.now): AgentStatusRegistry {
  const snapshots = new Map<string, AgentStatusSnapshot>();
  const listeners = new Set<AgentStatusListener>();
  const emit = () => {
    const list = [...snapshots.values()];
    listeners.forEach((listener) => listener(list));
  };
  return {
    publish(snapshot) {
      const previous = snapshots.get(snapshot.id);
      // Only a real state change moves the clock. Nodes re-publish on every incidental change — a
      // rename, a session id, a runner label — and re-stamping on those would reset the duration
      // constantly, so it would never grow past a few seconds and the row would stay as
      // uninformative as it was before the field existed.
      const statusChangedAt =
        snapshot.statusChangedAt
        ?? (previous && previous.status === snapshot.status ? previous.statusChangedAt : undefined)
        ?? now();
      snapshots.set(snapshot.id, { ...snapshot, statusChangedAt });
      emit();
    },
    remove(id) {
      if (snapshots.delete(id)) emit();
    },
    list() {
      return [...snapshots.values()];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Process-wide status registry shared by AgentNodes and the Inbox panel. */
export const agentStatusRegistry: AgentStatusRegistry = createAgentStatusRegistry();
