"use client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Edge, Node, OnMoveEnd, ReactFlowInstance } from "@xyflow/react";
import {
  canvasViewportZoomBoundsForNodeCount,
  saveCanvasViewport,
  viewportForCanvasProject,
  type CanvasViewportMode,
} from "../services/canvas-viewport-store";
import { getCanvasBehaviorSettings } from "./useCanvasBehaviorSettings";

export function useCanvasViewportPersistence(
  activeProjectId: string | null,
  nodeCount: number,
  flowInstance: ReactFlowInstance<Node, Edge> | null,
  mode: CanvasViewportMode = "board",
) {
  const viewportZoomBounds = useMemo(() => canvasViewportZoomBoundsForNodeCount(nodeCount), [nodeCount]);
  const viewportZoomBoundsRef = useRef(viewportZoomBounds);
  // When restore-on-open is off, hand xyflow the default frame instead of the
  // saved one. Read non-reactively: the choice applies at mount/open, not live.
  const initialViewport = getCanvasBehaviorSettings().restoreViewportOnOpen
    ? viewportForCanvasProject(activeProjectId, viewportZoomBounds, mode)
    : viewportForCanvasProject(null, viewportZoomBounds, mode);

  const handleMoveEnd = useCallback<OnMoveEnd>((_, viewport) => {
    saveCanvasViewport(activeProjectId, viewport, viewportZoomBounds, mode);
  }, [activeProjectId, mode, viewportZoomBounds]);

  useEffect(() => {
    viewportZoomBoundsRef.current = viewportZoomBounds;
  }, [viewportZoomBounds]);

  useEffect(() => {
    if (!flowInstance || !activeProjectId) return;
    // Read the flag at open-time (not via deps) so toggling it only affects the
    // next project open, not the current viewport. Project switching restores the
    // saved frame instantly so large boards do not spend a few hundred ms gliding.
    if (!getCanvasBehaviorSettings().restoreViewportOnOpen) return;
    const viewport = viewportForCanvasProject(activeProjectId, viewportZoomBoundsRef.current, mode);
    flowInstance.setViewport(viewport, { duration: 0 });
  }, [activeProjectId, flowInstance, mode]);

  return { viewportZoomBounds, initialViewport, handleMoveEnd };
}
