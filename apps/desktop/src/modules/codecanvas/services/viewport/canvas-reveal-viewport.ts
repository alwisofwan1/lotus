/**
 * Minimal-pan reveal: bring a node into view by moving the camera as little as
 * possible, instead of re-framing the whole cluster.
 *
 * Why this exists. Opening the Skills node used to call `fitView` over
 * [terminal, skills] and opening a skill re-framed [terminal, skills, preview] —
 * a 1788px-wide bounding box that dropped zoom to ~0.62 and threw the camera far
 * to the right of whatever the user was reading. The camera should behave like a
 * scroll container: if the new node already fits on screen, do not move at all;
 * if it pokes out, nudge by exactly the overflow; only zoom out when the node
 * genuinely cannot fit at the current zoom, and only as far as it must.
 *
 * Pure — callers own the viewport animation.
 */
import type { VisibleCanvasArea } from "./canvas-visible-frame";

export interface CanvasFlowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface RevealViewportOptions {
  /** Breathing room between the revealed rect and the visible-area edge, in screen px. */
  margin?: number;
  /** How far the camera may zoom out to make a rect fit. */
  minZoom?: number;
  /** Sub-pixel moves are not worth animating. */
  epsilon?: number;
}

const DEFAULT_MARGIN = 24;
const DEFAULT_MIN_ZOOM = 0.5;
const DEFAULT_EPSILON = 0.5;

export function unionFlowRects(rects: readonly CanvasFlowRect[]): CanvasFlowRect {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Is `rect` (flow coords) fully inside the visible area under `viewport`, allowing `margin`? */
export function isRectRevealed(
  rect: CanvasFlowRect,
  viewport: CanvasViewportTransform,
  area: VisibleCanvasArea,
  margin = DEFAULT_MARGIN,
): boolean {
  const left = rect.x * viewport.zoom + viewport.x;
  const top = rect.y * viewport.zoom + viewport.y;
  const right = left + rect.w * viewport.zoom;
  const bottom = top + rect.h * viewport.zoom;
  return (
    left >= area.left + margin &&
    top >= area.top + margin &&
    right <= area.left + area.width - margin &&
    bottom <= area.top + area.height - margin
  );
}

/**
 * The viewport that reveals `rect` with the least movement, or `null` when the
 * camera is already showing it — the caller should then do nothing at all.
 */
export function revealViewportForRect(
  rect: CanvasFlowRect,
  viewport: CanvasViewportTransform,
  area: VisibleCanvasArea,
  options: RevealViewportOptions = {},
): CanvasViewportTransform | null {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;

  if (isRectRevealed(rect, viewport, area, margin)) return null;

  // Zoom out only as far as needed to fit, and never zoom IN — a reveal must not
  // magnify the board under the user.
  const fitZoom = Math.min(
    (area.width - margin * 2) / Math.max(rect.w, 1),
    (area.height - margin * 2) / Math.max(rect.h, 1),
  );
  const zoom = Math.max(minZoom, Math.min(viewport.zoom, fitZoom));

  // Re-anchor on the visible-area centre so a zoom change does not also slide the
  // board sideways; the clamp below then does the actual reveal.
  const next = { x: viewport.x, y: viewport.y, zoom };
  if (zoom !== viewport.zoom) {
    const centreX = area.left + area.width / 2;
    const centreY = area.top + area.height / 2;
    next.x = centreX - ((centreX - viewport.x) / viewport.zoom) * zoom;
    next.y = centreY - ((centreY - viewport.y) / viewport.zoom) * zoom;
  }

  next.x = clampAxis(next.x, rect.x, rect.w, zoom, area.left, area.width, margin);
  next.y = clampAxis(next.y, rect.y, rect.h, zoom, area.top, area.height, margin);

  const moved =
    Math.abs(next.x - viewport.x) > epsilon ||
    Math.abs(next.y - viewport.y) > epsilon ||
    next.zoom !== viewport.zoom;
  return moved ? next : null;
}

/**
 * Reveal `primary`, and include `alsoShow` (the parent terminal, say) only when
 * they come along for free — i.e. the union still fits without zooming out past
 * `minZoom`. Context is nice; losing the node you just opened is not.
 */
export function revealViewportForNodes(
  primary: CanvasFlowRect,
  alsoShow: readonly CanvasFlowRect[],
  viewport: CanvasViewportTransform,
  area: VisibleCanvasArea,
  options: RevealViewportOptions = {},
): CanvasViewportTransform | null {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;

  if (alsoShow.length > 0) {
    const union = unionFlowRects([primary, ...alsoShow]);
    const unionFitZoom = Math.min(
      (area.width - margin * 2) / Math.max(union.w, 1),
      (area.height - margin * 2) / Math.max(union.h, 1),
    );
    // `>=` so a union that fits exactly at the current zoom still counts as free.
    if (Math.min(viewport.zoom, unionFitZoom) >= minZoom) {
      return revealViewportForRect(union, viewport, area, options);
    }
  }

  return revealViewportForRect(primary, viewport, area, options);
}

function clampAxis(
  offset: number,
  rectStart: number,
  rectSize: number,
  zoom: number,
  areaStart: number,
  areaSize: number,
  margin: number,
): number {
  // Lower bound keeps the rect's NEAR edge inside; upper bound keeps its FAR edge
  // inside. They cross only if the rect cannot fit, which the zoom step above has
  // already ruled out except at the minZoom floor — there, show the rect's start.
  const min = areaStart + margin - rectStart * zoom;
  const max = areaStart + areaSize - margin - (rectStart + rectSize) * zoom;
  if (min > max) return min;
  return Math.min(max, Math.max(min, offset));
}
