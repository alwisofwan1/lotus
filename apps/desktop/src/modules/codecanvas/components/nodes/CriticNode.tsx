"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, type NodeProps } from "@xyflow/react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { CriticNodeCard } from "./CriticNodeCard";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { useAgentNodeState } from "../../hooks/useAgentNodeState";
import { useAgentRunRegistration } from "../../hooks/useAgentRunRegistration";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import { agentRunStore } from "../../services/agent-run-store";
import { agentRunRegistry } from "../../services/agent-run-registry";
import { canvasHandoffStore } from "../../services/canvas-handoff-store";
import { resolveUpstreamContext } from "../../services/canvas-upstream-context";
import { parseCriticVerdict, type CriticVerdict } from "../../services/critic-verdict";
import { CRITIC_ROLE_PROMPT } from "../../services/critic-prompt";
import type { AgentContextSource } from "../../services/agent-run-prompt";
import type { CanvasCriticNodeData } from "../../types/canvas";

const glyphTone = (v: CriticVerdict | null) => (v === "pass" ? "done" : v === "fail" ? "error" : "neutral");

/** A skeptical gate: runs the critic role over its upstream input and emits a PASS/FAIL verdict (N4). */
export const CriticNode = memo(function CriticNode({ id, data, selected }: NodeProps) {
  const { title, cwd, model, dispatchCommand, onClose, onChange } = data as CanvasCriticNodeData;
  const lodTier = useCanvasLodTier();
  const flow = useReactFlow();
  const [verdict, setVerdict] = useState<CriticVerdict | null>(null);
  const verdictRef = useRef<CriticVerdict | null>(null);
  const lastRunRef = useRef<{ sessionId: string | null; nodeRunId: string; usage?: { inputTokens: number; outputTokens: number; costUsd?: number } | null } | null>(null);

  const getContext = useCallback((activeGraphRunId?: string | null): AgentContextSource[] =>
    resolveUpstreamContext(flow, id, activeGraphRunId), [flow, id]);

  const { status, start, stop } = useAgentNodeState({
    prompt: CRITIC_ROLE_PROMPT, model, cwd, getContext, agentId: id,
    onRunComplete: (record) => {
      const v = record.outcome === "stopped" ? null : parseCriticVerdict(record.summary ?? "");
      verdictRef.current = v;
      setVerdict(v);
      lastRunRef.current = { sessionId: record.sessionId, nodeRunId: record.id, usage: record.usage };
      void agentRunStore.append(record);
      // The review is this critic's handoff: a critic wired after it judges it (#112).
      if (record.outcome === "completed" && record.summary?.trim()) {
        canvasHandoffStore.set(id, { name: title, summary: record.summary, sessionId: record.sessionId });
      }
    },
  });

  // Report a graph result whose `gate` carries the verdict: FAIL → outcome error → closes the gate.
  useAgentRunRegistration(id, status, start, agentRunRegistry, () => {
    const v = verdictRef.current;
    const last = lastRunRef.current;
    if (!v || !last) return null;
    return { outcome: v === "pass" ? "completed" : "error", sessionId: last.sessionId, nodeRunId: last.nodeRunId, gate: v, usage: last.usage };
  });

  useEffect(() => { agentStatusRegistry.publish({ id, name: title, status }); }, [id, title, status]);
  useEffect(() => () => agentStatusRegistry.remove(id), [id]);

  const handleClose = useCallback(() => {
    void stop();
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, stop, onClose, id]);
  const onTitleChange = useCallback((next: string) => {
    if (dispatchCommand) dispatchCommand({ kind: "patch-critic", nodeId: id, patch: { title: next } });
    else onChange?.(id, { title: next });
  }, [dispatchCommand, id, onChange]);

  return (
    <CanvasNodeFrame kind="critic" selected={!!selected} minWidth={240} minHeight={180} header={null}
      lodTier={lodTier}
      glyph={<CanvasNodeGlyph label={title} tone={glyphTone(verdict)} detail="critic" />}
    >
      <CriticNodeCard
        title={title}
        status={status}
        verdict={verdict}
        onTitleChange={onTitleChange}
        onRun={() => void start()}
        onStop={() => void stop()}
        onClose={handleClose}
        onFocus={dispatchCommand ? () => dispatchCommand({ kind: "focus-node", nodeId: id }) : undefined}
      />
    </CanvasNodeFrame>
  );
});
