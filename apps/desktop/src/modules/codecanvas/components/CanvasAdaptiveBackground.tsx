"use client";
import { Background, type BackgroundVariant, useStore } from "@xyflow/react";
import {
  canvasBackgroundGapForZoom,
  canvasBackgroundSizeForZoom,
} from "../services/viewport/canvas-viewport-policy";

export { canvasBackgroundGapForZoom, canvasBackgroundSizeForZoom };

/** Minimal dot/line backdrop spec — decoupled from any specific theme type so the
 *  active Artisan theme (paper.pattern) can drive it directly. */
export interface CanvasBackgroundPattern {
  variant: BackgroundVariant;
  gap: number;
  size: number;
  color: string;
}

interface CanvasAdaptiveBackgroundProps {
  theme: CanvasBackgroundPattern;
}

export function CanvasAdaptiveBackground({ theme }: CanvasAdaptiveBackgroundProps) {
  const zoom = useStore((state) => state.transform[2]);
  // ReactFlow's <Background> derives the dot/line geometry as `size * transform[2]`, so a
  // transient non-finite zoom (e.g. a fitView on not-yet-measured nodes during init) would
  // emit `cx="NaN"`. Skip the pattern for that frame; it renders again once zoom is finite.
  if (!Number.isFinite(zoom)) return null;
  return (
    <Background
      variant={theme.variant}
      gap={canvasBackgroundGapForZoom(theme.gap, zoom)}
      size={canvasBackgroundSizeForZoom(theme.size, zoom)}
      color={theme.color}
    />
  );
}
