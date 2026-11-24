"use client";
import { memo, useCallback } from "react";
import type { NodeProps } from "@xyflow/react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { MusicNodeCard } from "./MusicNodeCard";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import type { CanvasMusicNodeData, MusicNodePatch } from "../../types/canvas";

/**
 * The CodeCanvas music player (plan `canvas-music-player`, persistence reworked in
 * `canvas-music-persistent-playback`).
 *
 * The node is pure chrome now, so it may collapse to a glyph freely: playback lives
 * in the app-level music engine, not in this subtree. v1 had to suppress the glyph
 * while playing, because collapsing unmounted the card — and with it the `<iframe>`
 * that was making the sound.
 */
export const MusicNode = memo(function MusicNode({ id, data, selected }: NodeProps) {
  const { activeTrackId, volume, dispatchCommand, onClose, onChange } = data as CanvasMusicNodeData;
  const lodTier = useCanvasLodTier();

  const handlePatch = useCallback((patch: MusicNodePatch) => {
    if (dispatchCommand) dispatchCommand({ kind: "patch-music", nodeId: id, patch });
    else onChange?.(id, patch);
  }, [dispatchCommand, id, onChange]);
  const handleClose = useCallback(() => {
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, id, onClose]);
  const handleFocus = useCallback(() => {
    dispatchCommand?.({ kind: "focus-node", nodeId: id });
  }, [dispatchCommand, id]);

  return (
    <CanvasNodeFrame kind="music" selected={!!selected} minWidth={300} minHeight={220} header={null}
      lodTier={lodTier}
      glyph={<CanvasNodeGlyph label="Music Player" tone="neutral" />}
    >
      <MusicNodeCard
        activeTrackId={activeTrackId}
        volume={volume}
        onPatch={handlePatch}
        onClose={handleClose}
        onFocus={dispatchCommand ? handleFocus : undefined}
      />
    </CanvasNodeFrame>
  );
});
