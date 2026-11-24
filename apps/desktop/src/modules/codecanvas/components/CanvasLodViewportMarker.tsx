"use client";
import { Panel } from "@xyflow/react";
import { useCanvasLodTier } from "../hooks/useCanvasLodTier";

/** Hidden viewport marker that lets CSS simplify global canvas chrome by LOD tier. */
export function CanvasLodViewportMarker() {
  const lodTier = useCanvasLodTier();
  return <Panel position="top-left" className="canvas-lod-marker" data-canvas-lod={lodTier} aria-hidden />;
}
