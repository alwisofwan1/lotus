"use client";
import { memo, useCallback, useEffect } from "react";
import { Hand, X } from "lucide-react";
import { type NodeProps } from "@xyflow/react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { agentRunRegistry } from "../../services/agent-run-registry";
import { decideHumanGate, humanGateWaitPatch } from "../../services/human-gate-decision";
import type { CanvasHumanGateNodeData, CanvasHumanGateStatus } from "../../types/canvas";

function toneFor(status: CanvasHumanGateStatus): "neutral" | "active" | "done" | "error" {
  if (status === "waiting") return "active";
  if (status === "approved") return "done";
  if (status === "rejected") return "error";
  return "neutral";
}

/** Manual approval/clarification gate. It pauses a graph run until the user decides. */
export const HumanGateNode = memo(function HumanGateNode({ id, data, selected }: NodeProps) {
  const { title, instructions, gateKind, status, dispatchCommand, onClose, onChange } = data as CanvasHumanGateNodeData;
  const lodTier = useCanvasLodTier();

  const patchGate = useCallback((patch: Parameters<NonNullable<CanvasHumanGateNodeData["onChange"]>>[1]) => {
    if (dispatchCommand) dispatchCommand({ kind: "patch-human-gate", nodeId: id, patch });
    else onChange?.(id, patch);
  }, [dispatchCommand, id, onChange]);
  const closeGate = useCallback(() => {
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, id, onClose]);

  useEffect(() => agentRunRegistry.register(id, {
    run: () => patchGate(humanGateWaitPatch(Date.now())),
  }), [id, patchGate]);

  const approve = useCallback(() => decideHumanGate(id, "approve", patchGate), [id, patchGate]);
  const reject = useCallback(() => decideHumanGate(id, "reject", patchGate), [id, patchGate]);

  const updateTitle = useCallback((event: React.ChangeEvent<HTMLInputElement>) => patchGate({ title: event.target.value }), [patchGate]);
  const updateInstructions = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => patchGate({ instructions: event.target.value }), [patchGate]);

  return (
    <CanvasNodeFrame
      kind="human-gate"
      selected={!!selected}
      minWidth={260}
      minHeight={190}
      header={null}
      lodTier={lodTier}
      glyph={<CanvasNodeGlyph label={title} tone={toneFor(status)} detail={gateKind === "approval" ? "approval" : "clarify"} />}
    >
      <div className="canvas-critic canvas-human-gate">
        <div className="canvas-critic-head">
          <Hand size={13} aria-hidden className="canvas-critic-icon" />
          <input className="canvas-critic-title" value={title} onChange={updateTitle} aria-label="Human gate title" />
          {dispatchCommand && (
            <CanvasNodeFocusAction
              onFocus={() => dispatchCommand({ kind: "focus-node", nodeId: id })}
              className="canvas-critic-close canvas-node-focus"
              iconSize={12}
            />
          )}
          <button type="button" className="canvas-critic-close" onClick={closeGate} aria-label="Close human gate">
            <X size={12} aria-hidden />
          </button>
        </div>
        <p className="canvas-critic-hint">Pauses downstream until a human {gateKind === "approval" ? "approves" : "clarifies"} this gate.</p>
        <textarea
          className="canvas-human-gate-instructions"
          value={instructions}
          onChange={updateInstructions}
          aria-label="Human gate instructions"
        />
        <div className="canvas-critic-foot">
          <span className={`canvas-critic-status canvas-human-gate-status--${status}`}>{status}</span>
          <button type="button" className="canvas-critic-btn" disabled={status !== "waiting"} onClick={approve}>Approve</button>
          <button type="button" className="canvas-critic-btn" disabled={status !== "waiting"} onClick={reject}>Reject</button>
        </div>
      </div>
    </CanvasNodeFrame>
  );
});
