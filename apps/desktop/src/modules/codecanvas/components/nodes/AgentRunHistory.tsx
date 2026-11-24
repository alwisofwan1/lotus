"use client";
import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { agentRunStore, type AgentRunStore } from "../../services/agent-run-store";
import type { AgentRunRecord } from "../../services/agent-run-record";

interface Props {
  agentId: string;
  onClose: () => void;
  store?: AgentRunStore;
  /** When a prior graph run exists, this node can be replayed (time-travel) from here. */
  canReplay?: boolean;
  onReplayFrom?: () => void;
}

const seconds = (run: AgentRunRecord) => Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));

const compactTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function usageLabel(run: AgentRunRecord): string | null {
  if (!run.usage) return null;
  const tokens = compactTokens(run.usage.inputTokens + run.usage.outputTokens);
  const cost = typeof run.usage.costUsd === "number" ? ` · $${run.usage.costUsd.toFixed(3)}` : "";
  return `${tokens} tok${cost}`;
}

/** Per-node run trace: past runs (kind · duration · outcome · cost), drill into each run's actions. */
export function AgentRunHistory({ agentId, onClose, store = agentRunStore, canReplay = false, onReplayFrom }: Props) {
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => { void store.list(agentId).then(setRuns); }, [agentId, store]);

  return (
    <div className="agent-history nodrag nowheel">
      <div className="agent-history-head">
        <span className="agent-history-title">Run history</span>
        <button className="canvas-node-close" aria-label="Close run history" onClick={onClose}>
          <X size={11} aria-hidden />
        </button>
      </div>
      {canReplay && onReplayFrom && (
        <button className="agent-history-replay" onClick={onReplayFrom}>
          <RotateCcw size={11} aria-hidden /> Re-run graph from here
        </button>
      )}
      {runs.length === 0 ? (
        <p className="agent-history-empty">No runs yet.</p>
      ) : (
        <ul className="agent-history-list">
          {runs.map((run) => (
            <li key={run.id} className="agent-history-row">
              <button
                className="agent-history-summary"
                aria-label={`${run.kind} run, ${run.outcome}`}
                onClick={() => setOpenId(openId === run.id ? null : run.id)}
              >
                <span className={`agent-history-dot agent-history-dot--${run.outcome}`} aria-hidden />
                <span className="agent-history-kind">{run.kind}</span>
                <span className="agent-history-dur">{seconds(run)}s</span>
                {usageLabel(run) && <span className="agent-history-usage">{usageLabel(run)}</span>}
                <span className={`agent-history-outcome agent-history-outcome--${run.outcome}`}>{run.outcome}</span>
              </button>
              {openId === run.id && (
                <pre className="agent-history-actions">{run.actions.join("\n") || "(no actions recorded)"}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
