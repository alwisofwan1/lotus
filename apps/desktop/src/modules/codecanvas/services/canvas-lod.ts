import type { CanvasLodTier } from "./viewport/canvas-viewport-policy";

/**
 * Decision 44: while the Frame Overview is open and its content fits the live budget, nodes keep full detail
 * instead of collapsing to the zoom-driven glyph tier (the Overview sits below the 0.5 glyph threshold).
 */
export function canvasLodTierWithOverview(tier: CanvasLodTier, overviewFullDetail: boolean): CanvasLodTier {
  return overviewFullDetail ? "full" : tier;
}

export {
  CANVAS_LOD_GLYPH_BELOW_ZOOM,
  CANVAS_LOD_GLYPH_ENTER_ZOOM,
  CANVAS_LOD_GLYPH_EXIT_ZOOM,
  CANVAS_LOD_OVERVIEW_BELOW_ZOOM,
  CANVAS_LOD_OVERVIEW_ENTER_ZOOM,
  CANVAS_LOD_OVERVIEW_EXIT_ZOOM,
  canvasLodTierForZoom,
  canvasLodTierWithHysteresis,
  type CanvasLodTier,
} from "./viewport/canvas-viewport-policy";
