"use client";
import { useEffect, useRef, useState } from "react";
import { agentRunRegistry, type AgentRunContext, type AgentRunRegistry } from "../services/agent-run-registry";
import { agentStatusRegistry } from "../services/agent-status-registry";
import { canvasHandoffStore } from "../services/canvas-handoff-store";
import type { AgentTurnFact } from "../services/agent-turn-registry";
import { buildLiveRunMessage, liveRunTurnOutcome, type LiveRunUpstream } from "../services/live-agent-graph-run";
import type { AgentNodeStatus } from "../types/canvas";

export interface LiveAgentRunInput {
  id: string;
  name: string;
  /** Types one message into the terminal as a turn (queues while the runner boots). */
  submit: (text: string) => Promise<void> | void;
  fact: AgentTurnFact | undefined;
  reportsTurnEnd: boolean;
  status: AgentNodeStatus;
  ptyEnded: boolean;
  sessionId: string | null;
  registry?: AgentRunRegistry;
}

interface ActiveStep {
  submittedAtMs: number;
  nodeRunId: string;
  sawBusy: boolean;
}

/** Names + handoff summaries of the steps that ran before this one. */
function upstreamOf(ids: readonly string[]): LiveRunUpstream[] {
  const roster = new Map(agentStatusRegistry.list().map((a) => [a.id, a.name]));
  return ids.map((uid) => {
    const handoff = canvasHandoffStore.get(uid);
    return { name: handoff?.name ?? roster.get(uid) ?? "a previous step", ...(handoff?.summary ? { summary: handoff.summary } : {}) };
  });
}

/**
 * Makes a live agent a graph-run step (ticket #80): `run` types the step into the terminal, and
 * the turn signals decide when it is over (see `liveRunTurnOutcome`). A manual chat with the agent
 * never reports to a run — only a step this hook started does.
 */
export function useLiveAgentRunRegistration(input: LiveAgentRunInput): void {
  const { id, fact, reportsTurnEnd, status, ptyEnded, registry = agentRunRegistry } = input;
  const latest = useRef(input);
  useEffect(() => { latest.current = input; });
  const activeRef = useRef<ActiveStep | null>(null);
  // Bumped when a step starts, so the outcome check also runs when no signal changes afterwards.
  const [stepVersion, setStepVersion] = useState(0);

  useEffect(() => {
    const finish = (ok: boolean) => {
      const step = activeRef.current;
      if (!step) return;
      activeRef.current = null;
      registry.reportResult(id, ok, { outcome: ok ? "completed" : "error", sessionId: latest.current.sessionId, nodeRunId: step.nodeRunId });
    };
    return registry.register(id, {
      run: (ctx?: AgentRunContext) => {
        const now = Date.now();
        activeRef.current = { submittedAtMs: now, nodeRunId: `live-${id}-${now}`, sawBusy: false };
        if (!ctx?.run?.brief.trim()) {
          // Nothing to type: a live agent needs a task, and only a Run Node's goal provides one.
          finish(false);
          return;
        }
        const text = buildLiveRunMessage({
          runTitle: ctx.run.title,
          brief: ctx.run.brief,
          agentName: latest.current.name,
          upstream: upstreamOf(ctx.upstreamIds ?? []),
        });
        void Promise.resolve()
          .then(() => latest.current.submit(text))
          .catch(() => finish(false));
        setStepVersion((v) => v + 1);
      },
    });
  }, [id, registry]);

  useEffect(() => {
    const step = activeRef.current;
    if (!step) return;
    if (status === "running") step.sawBusy = true;
    const outcome = liveRunTurnOutcome({ submittedAtMs: step.submittedAtMs, fact, reportsTurnEnd, status, ptyEnded, sawBusy: step.sawBusy });
    if (outcome === "pending") return;
    activeRef.current = null;
    registry.reportResult(id, outcome === "completed", {
      outcome: outcome === "completed" ? "completed" : "error",
      sessionId: latest.current.sessionId,
      nodeRunId: step.nodeRunId,
    });
  }, [id, registry, fact, reportsTurnEnd, status, ptyEnded, stepVersion]);
}
