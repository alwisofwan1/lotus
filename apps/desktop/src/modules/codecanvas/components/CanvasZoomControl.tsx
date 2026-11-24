"use client";
import { memo, useCallback } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useReactFlow, useStore } from "@xyflow/react";
import { canvasClampZoom, type CanvasViewportZoomBounds } from "../services/canvas-viewport-store";
import { CANVAS_MOTION, canvasEaseOutQuint, canvasMotionDuration } from "../services/canvas-motion";
import { runCanvasViewportMotion, viewportForZoomAroundRectCenter } from "../services/viewport/canvas-viewport-motion";

const CANVAS_ZOOM_STEP = 1.2;
const ZOOM_EPSILON = 0.001;

export function formatCanvasZoomPercentage(zoom: number): string {
  if (!Number.isFinite(zoom)) return "100%";
  return `${Math.round(zoom * 100)}%`;
}

export function nextCanvasZoom(
  zoom: number,
  direction: "in" | "out",
  bounds: CanvasViewportZoomBounds,
): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1;
  const next = direction === "in" ? safeZoom * CANVAS_ZOOM_STEP : safeZoom / CANVAS_ZOOM_STEP;
  return canvasClampZoom(Math.round(next * 10000) / 10000, bounds);
}

interface CanvasZoomControlViewProps {
  zoom: number;
  bounds: CanvasViewportZoomBounds;
  onFitAll: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export const CanvasZoomControlView = memo(function CanvasZoomControlView({
  zoom,
  bounds,
  onFitAll,
  onZoomIn,
  onZoomOut,
}: CanvasZoomControlViewProps) {
  const displayZoom = canvasClampZoom(zoom, bounds);
  const atMin = displayZoom <= bounds.minZoom + ZOOM_EPSILON;
  const atMax = displayZoom >= bounds.maxZoom - ZOOM_EPSILON;

  return (
    <div className="canvas-zoom-control" role="group" aria-label="Canvas zoom controls">
      <button type="button" className="canvas-zoom-control-btn" aria-label="Fit all canvas nodes" onClick={onFitAll}>
        <Maximize2 size={13} aria-hidden />
      </button>
      <button type="button" className="canvas-zoom-control-btn" aria-label="Zoom out canvas" disabled={atMin} onClick={onZoomOut}>
        <Minus size={14} aria-hidden />
      </button>
      <span className="canvas-zoom-control-label" aria-label={`Canvas zoom ${formatCanvasZoomPercentage(displayZoom)}`}>
        {formatCanvasZoomPercentage(displayZoom)}
      </span>
      <button type="button" className="canvas-zoom-control-btn" aria-label="Zoom in canvas" disabled={atMax} onClick={onZoomIn}>
        <Plus size={14} aria-hidden />
      </button>
    </div>
  );
});

export interface CanvasZoomActions {
  zoom: number;
  handleFitAll: () => void;
  handleZoomIn: () => void;
  handleZoomOut: () => void;
}

/**
 * ReactFlow-connected zoom actions (animated fit/in/out). Extracted so the unified corner control
 * bar can drive zoom without owning a Panel of its own. Must be used inside a ReactFlow provider.
 */
export function useCanvasZoomActions(
  bounds: CanvasViewportZoomBounds,
  nodeCount: number,
): CanvasZoomActions {
  const flow = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);

  const zoomTo = useCallback(
    (nextZoom: number) => {
      const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
      const rect = pane?.getBoundingClientRect();
      const current = flow.getViewport();
      const duration = canvasMotionDuration(CANVAS_MOTION.zoomMs);
      const viewport = rect
        ? viewportForZoomAroundRectCenter(current, nextZoom, { width: rect.width, height: rect.height })
        : { ...current, zoom: nextZoom };
      void runCanvasViewportMotion(
        { currentZoom: current.zoom, durationMs: duration },
        () => flow.setViewport(viewport, {
          duration,
          ease: canvasEaseOutQuint,
          interpolate: "linear",
        }),
      );
    },
    [flow],
  );

  const handleZoomIn = useCallback(() => {
    zoomTo(nextCanvasZoom(zoom, "in", bounds));
  }, [bounds, zoom, zoomTo]);

  const handleZoomOut = useCallback(() => {
    zoomTo(nextCanvasZoom(zoom, "out", bounds));
  }, [bounds, zoom, zoomTo]);

  const handleFitAll = useCallback(() => {
    if (nodeCount === 0) {
      const current = flow.getViewport();
      const duration = canvasMotionDuration(CANVAS_MOTION.resetMs);
      void runCanvasViewportMotion(
        { currentZoom: current.zoom, durationMs: duration },
        () => flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration, ease: canvasEaseOutQuint, interpolate: "linear" }),
      );
      return;
    }
    const current = flow.getViewport();
    const duration = canvasMotionDuration(CANVAS_MOTION.fitMs);
    void runCanvasViewportMotion(
      { currentZoom: current.zoom, durationMs: duration },
      () => flow.fitView({
        padding: 0.22,
        minZoom: bounds.minZoom,
        maxZoom: Math.min(bounds.maxZoom, 1.05),
        duration,
        ease: canvasEaseOutQuint,
        interpolate: "smooth",
      }),
    );
  }, [bounds.maxZoom, bounds.minZoom, flow, nodeCount]);

  return { zoom, handleFitAll, handleZoomIn, handleZoomOut };
}
