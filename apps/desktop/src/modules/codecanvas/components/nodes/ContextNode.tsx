"use client";
import { memo, useCallback, useMemo } from "react";
import type { NodeProps } from "@xyflow/react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { ContextNodeCard } from "./ContextNodeCard";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { useContextBusArtifacts } from "../../hooks/useContextBusArtifacts";
import { useCodeCanvasProjectMemory } from "../../hooks/useCodeCanvasProjectMemory";
import { mergeContextArtifacts, projectMemoryAsContextArtifacts } from "../../services/memory/codecanvas-memory-context-projection";
import type { CanvasContextNodeData } from "../../types/canvas";

/** The visual surface of one Shared Context Bus: subscribes to its artifacts and renders them live. */
export const ContextNode = memo(function ContextNode({ id, data, selected }: NodeProps) {
  const { title, projectId, dispatchCommand, onClose, onChange } = data as CanvasContextNodeData & { projectId?: string };
  const busArtifacts = useContextBusArtifacts(id);
  // Phase 5 projection: durable project memory (decisions, constraints, artifacts, promoted native
  // context) surfaces on the bus behind live run artifacts. No projectId ⇒ inert, bus-only behavior.
  const memory = useCodeCanvasProjectMemory(typeof projectId === "string" ? projectId : null);
  const artifacts = useMemo(
    () => mergeContextArtifacts(busArtifacts, projectMemoryAsContextArtifacts(memory.items, id)),
    [busArtifacts, memory.items, id],
  );
  const lodTier = useCanvasLodTier();

  const onTitleChange = useCallback((next: string) => {
    if (dispatchCommand) dispatchCommand({ kind: "patch-context", nodeId: id, patch: { title: next } });
    else onChange?.(id, { title: next });
  }, [dispatchCommand, id, onChange]);
  const handleClose = useCallback(() => {
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, id, onClose]);

  return (
    <CanvasNodeFrame kind="context" selected={!!selected} minWidth={260} minHeight={220} header={null}
      lodTier={lodTier}
      glyph={<CanvasNodeGlyph label={title} tone={artifacts.length > 0 ? "done" : "neutral"} detail={`${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`} />}
    >
      <ContextNodeCard title={title} artifacts={artifacts} onTitleChange={onTitleChange} onClose={handleClose} onFocus={dispatchCommand ? () => dispatchCommand({ kind: "focus-node", nodeId: id }) : undefined} />
    </CanvasNodeFrame>
  );
});
