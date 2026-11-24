"use client";
import { memo, useCallback } from "react";
import type { NodeProps } from "@xyflow/react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { HostCellNodeCard } from "./HostCellNodeCard";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { useHostCellConversation } from "../../hooks/useHostCellConversation";
import { isPageBusy } from "../../services/host-conversation";
import type { CanvasHostCellNodeData } from "../../types/canvas";

/**
 * A cell the project's machine runs **without a terminal**, adopted as its conversation
 * (ticket 12, `plans/codecanvas-vps-connector/issues/12`).
 *
 * The other half of ⌘K's Adopt row. A `tui` cell becomes a Terminal node attached over ssh to the
 * tmux session the host gave it; this one cannot, because the host runs it in memory through
 * `StructuredSessions` and there is no session, no PTY and no bytes. What exists instead is turns,
 * so that is what the node draws.
 *
 * **It only polls while it is legible.** The LOD tier is the signal: collapsed to a glyph, the
 * node is not being read, and each read costs an ssh round trip. See `conversationPollDelayMs`.
 */
export const HostCellNode = memo(function HostCellNode({ id, data, selected }: NodeProps) {
  const { adoptedPaneId, cwd, label, provider, dispatchCommand, onClose } = data as CanvasHostCellNodeData;
  const lodTier = useCanvasLodTier();
  const { page, error, loading, sending, send } = useHostCellConversation(adoptedPaneId, lodTier === "full");

  const handleSend = useCallback((prompt: string) => { void send(prompt); }, [send]);
  const handleClose = useCallback(() => {
    // Closing the node closes the node. The cell keeps running on that machine — it was started
    // elsewhere and adoption never took ownership of its life, so killing it here would be the
    // canvas reaching further than it was invited.
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, id, onClose]);
  const handleFocus = useCallback(() => {
    dispatchCommand?.({ kind: "focus-node", nodeId: id });
  }, [dispatchCommand, id]);

  return (
    <CanvasNodeFrame
      kind="host-cell"
      selected={!!selected}
      minWidth={320}
      minHeight={280}
      header={null}
      lodTier={lodTier}
      statusTone={isPageBusy(page) ? "running" : "idle"}
      glyph={<CanvasNodeGlyph label={label} tone={isPageBusy(page) ? "active" : "neutral"} detail={page?.runnerLabel || provider} />}
    >
      <HostCellNodeCard
        label={label}
        cwd={cwd}
        provider={provider}
        page={page}
        error={error}
        loading={loading}
        sending={sending}
        onSend={handleSend}
        onClose={handleClose}
        onFocus={dispatchCommand ? handleFocus : undefined}
      />
    </CanvasNodeFrame>
  );
});
