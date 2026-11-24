"use client";
import { useCallback } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { CANVAS_MOTION, canvasEaseOutQuint, canvasMotionDuration } from "../services/canvas-motion";
import { runCanvasViewportMotion } from "../services/viewport/canvas-viewport-motion";
import { getNodeSize } from "../services/canvas-node-placement";
import {
  revealViewportForNodes,
  type CanvasFlowRect,
} from "../services/viewport/canvas-reveal-viewport";
import { canvasDockInset, measureVisibleCanvasArea } from "../services/viewport/canvas-visible-frame";
import { getCanvasBehaviorSettings } from "../hooks/useCanvasBehaviorSettings";

interface UseCanvasFocusCommandsOptions {
  flowInstance: ReactFlowInstance<Node, Edge> | null;
  focusNode: (nodeId: string) => void;
  /** The Canvas Dock's state at the moment of the move, so a focused node lands clear of it. */
  readDock?: () => { open: boolean; wide: boolean };
}

/** Pixels `fitView` would give a fractional padding on one axis (xyflow's `parsePadding`). */
function fractionalPaddingPx(padding: number, size: number): number {
  return Math.floor((size - size / (1 + padding)) * 0.5);
}

function flowRectOf(node: Node): CanvasFlowRect {
  const size = getNodeSize(node);
  return { x: node.position.x, y: node.position.y, w: size.w, h: size.h };
}

/**
 * Viewport focus commands for CodeCanvas. Keeps fit/focus timing out of the page
 * container so selection and animated viewport movement have one small seam.
 */
export function useCanvasFocusCommands({ flowInstance, focusNode, readDock }: UseCanvasFocusCommandsOptions) {
  const focusCanvasNodes = useCallback(
    (nodeIds: readonly string[], selectedNodeId = nodeIds[nodeIds.length - 1]) => {
      if (!selectedNodeId) return;
      const focusIds = [...new Set(nodeIds.filter(Boolean))];
      focusNode(selectedNodeId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!flowInstance) return;
          const current = flowInstance.getViewport();
          const duration = canvasMotionDuration(CANVAS_MOTION.focusMs);
          const fraction = focusIds.length > 1 ? 0.18 : 0.32;
          // An open Dock covers the right of the pane: centre in what is left, or a Fleet row's node
          // lands underneath the list that was just clicked. The right side keeps the same gap.
          const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
          const paneWidth = pane?.getBoundingClientRect().width ?? 0;
          const dockInset = readDock && paneWidth > 0 ? canvasDockInset(readDock(), paneWidth) : 0;
          const padding = dockInset > 0
            ? { top: fraction, bottom: fraction, left: fraction, right: `${dockInset + fractionalPaddingPx(fraction, paneWidth)}px` as const }
            : fraction;
          void runCanvasViewportMotion(
            { currentZoom: current.zoom, durationMs: duration },
            () => flowInstance.fitView({
              nodes: focusIds.map((id) => ({ id })),
              padding,
              maxZoom: focusIds.length > 1 ? 0.95 : 1.05,
              duration,
              ease: canvasEaseOutQuint,
              interpolate: "smooth",
            }),
          );
        });
      });
    },
    [flowInstance, focusNode, readDock],
  );

  /**
   * Select a node and bring it on screen with the SMALLEST camera move that works —
   * no move at all when it is already visible.
   *
   * This is the counterpart to `focusCanvasNodes` for nodes that open *beside* what
   * the user is already reading (Skills, a skill reader). Re-framing a whole cluster
   * there reads as the camera flying away: opening a skill used to fit three nodes at
   * once and drop the zoom by a third. `alsoShow` nodes are included only when they
   * come along for free.
   */
  const revealCanvasNodes = useCallback(
    (primaryNodeId: string, alsoShowIds: readonly string[] = []) => {
      if (!primaryNodeId) return;
      focusNode(primaryNodeId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!flowInstance) return;
          const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
          const primary = flowInstance.getNode(primaryNodeId);
          if (!pane || !primary) return;

          const chrome = getCanvasBehaviorSettings();
          const paneRect = pane.getBoundingClientRect();
          const area = measureVisibleCanvasArea(paneRect, {
            showToolRail: chrome.showToolRail,
            topControls: chrome.topControls,
            dockInset: readDock ? canvasDockInset(readDock(), paneRect.width) : 0,
          });
          const companions = alsoShowIds
            .filter((id) => id && id !== primaryNodeId)
            .map((id) => flowInstance.getNode(id))
            .filter((node): node is Node => !!node)
            .map(flowRectOf);

          const current = flowInstance.getViewport();
          const target = revealViewportForNodes(flowRectOf(primary), companions, current, area);
          if (!target) return;

          const duration = canvasMotionDuration(CANVAS_MOTION.focusMs);
          void runCanvasViewportMotion(
            { currentZoom: current.zoom, durationMs: duration },
            () => flowInstance.setViewport(target, { duration, ease: canvasEaseOutQuint, interpolate: "smooth" }),
          );
        });
      });
    },
    [flowInstance, focusNode, readDock],
  );

  const focusCanvasNode = useCallback(
    (nodeId: string) => focusCanvasNodes([nodeId], nodeId),
    [focusCanvasNodes],
  );

  return { focusCanvasNodes, focusCanvasNode, revealCanvasNodes };
}
