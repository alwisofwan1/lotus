"use client";
import { useCallback, useRef } from "react";
import { useStore } from "@xyflow/react";
import { canvasLodTierWithOverview, type CanvasLodTier } from "../services/canvas-lod";
import { useFrameOverviewFullDetail } from "../services/canvas-frame-overview-store";
import { resolveCanvasLodTierDuringViewportMotion, setCanvasViewportStableLodTier } from "../services/viewport/canvas-viewport-motion";
import { useCanvasViewportMotionSnapshot } from "./useCanvasViewportMotion";

/**
 * Reactive Canvas LOD tier with hysteresis. The selector returns a derived tier string —
 * so a node re-renders only when it actually crosses a tier boundary, never per zoom frame —
 * and the hysteresis band keeps a viewport parked near the threshold from thrashing.
 */
export function useCanvasLodTier(): CanvasLodTier {
  const tierRef = useRef<CanvasLodTier>("full");
  const viewportMotion = useCanvasViewportMotionSnapshot();
  // Reading/advancing the ref inside the selector is safe: hysteresis is idempotent for a
  // given (zoom, previous), so repeated evaluations during a render converge to one tier.
  // During deliberate camera motion, keep semantic LOD frozen so a zoom tween does not
  // remount every heavy node body midway through the transition.
  const selector = useCallback((s: { transform: [number, number, number] }) => {
    const next = resolveCanvasLodTierDuringViewportMotion(s.transform[2], tierRef.current, viewportMotion);
    tierRef.current = next;
    if (!viewportMotion.active) setCanvasViewportStableLodTier(next);
    return next;
  }, [viewportMotion]);
  const tier = useStore(selector);
  return canvasLodTierWithOverview(tier, useFrameOverviewFullDetail());
}
