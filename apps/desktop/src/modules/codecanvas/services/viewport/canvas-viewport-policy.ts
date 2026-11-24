import type { Viewport } from "@xyflow/react";

export type CanvasLodTier = "full" | "glyph" | "overview";

/** Production zoom envelope. Kept broad for existing dense-board workflows. */
export const CANVAS_VIEWPORT_MIN_ZOOM = 0.01;
export const CANVAS_VIEWPORT_OVERVIEW_MIN_ZOOM = 0.01;
export const CANVAS_VIEWPORT_MAX_ZOOM = 20;

/** Below this viewport zoom a Canvas Node collapses to its glyph. */
export const CANVAS_LOD_GLYPH_BELOW_ZOOM = 0.5;

/** Below this viewport zoom a Canvas Node becomes an overview-map tile. */
export const CANVAS_LOD_OVERVIEW_BELOW_ZOOM = 0.12;

/** Hysteresis band around the glyph threshold. */
export const CANVAS_LOD_GLYPH_ENTER_ZOOM = 0.48;
export const CANVAS_LOD_GLYPH_EXIT_ZOOM = 0.55;

/** Hysteresis band around the overview threshold. */
export const CANVAS_LOD_OVERVIEW_ENTER_ZOOM = 0.12;
export const CANVAS_LOD_OVERVIEW_EXIT_ZOOM = 0.14;

export interface CanvasViewportZoomBounds {
  minZoom: number;
  maxZoom: number;
}

export interface CanvasNativeOverlayPolicyInput {
  dragging?: boolean;
  resizing?: boolean;
  lodTier: CanvasLodTier;
  /** A blocking DOM overlay (modal, dialog, menu) is open above the canvas. */
  overlayBlocked?: boolean;
}

export interface CanvasNativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  zoomFactor?: number;
}

export interface CanvasRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const CANVAS_BROWSER_FALLBACK_BOUNDS: CanvasNativeBrowserBounds = { x: 0, y: 0, width: 640, height: 480 };
export const CANVAS_BROWSER_PARKED_BOUNDS: CanvasNativeBrowserBounds = { x: -10000, y: -10000, width: 1, height: 1 };
export const CANVAS_NATIVE_WEBVIEW_SAFE_INSET = 8;
export const CANVAS_NATIVE_WEBVIEW_MIN_VISIBLE_SIZE = 8;
export const CANVAS_BROWSER_BOUNDS_EPSILON = 0.5;
export const CANVAS_BROWSER_BOUNDS_SYNC_THROTTLE_MS = 32;

const DEFAULT_ZOOM_BOUNDS: CanvasViewportZoomBounds = {
  minZoom: CANVAS_VIEWPORT_MIN_ZOOM,
  maxZoom: CANVAS_VIEWPORT_MAX_ZOOM,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeBounds(bounds: CanvasViewportZoomBounds = DEFAULT_ZOOM_BOUNDS): CanvasViewportZoomBounds {
  if (!isFiniteNumber(bounds.minZoom) || !isFiniteNumber(bounds.maxZoom) || bounds.minZoom > bounds.maxZoom) {
    return DEFAULT_ZOOM_BOUNDS;
  }
  return bounds;
}

export function canvasViewportZoomBoundsForNodeCount(nodeCount: number): CanvasViewportZoomBounds {
  void nodeCount;
  return { minZoom: CANVAS_VIEWPORT_OVERVIEW_MIN_ZOOM, maxZoom: CANVAS_VIEWPORT_MAX_ZOOM };
}

export function canvasClampZoom(zoom: number, bounds?: CanvasViewportZoomBounds): number {
  const normalized = normalizeBounds(bounds);
  if (!isFiniteNumber(zoom)) return normalized.minZoom;
  return Math.min(normalized.maxZoom, Math.max(normalized.minZoom, zoom));
}

export function readableCanvasViewport(viewport: Viewport, bounds?: CanvasViewportZoomBounds): Viewport {
  return { ...viewport, zoom: canvasClampZoom(viewport.zoom, bounds) };
}

export function canvasLodTierForZoom(zoom: number): CanvasLodTier {
  if (!Number.isFinite(zoom)) return "full";
  if (zoom < CANVAS_LOD_OVERVIEW_BELOW_ZOOM) return "overview";
  return zoom < CANVAS_LOD_GLYPH_BELOW_ZOOM ? "glyph" : "full";
}

export function canvasLodTierWithHysteresis(zoom: number, previous: CanvasLodTier): CanvasLodTier {
  if (!Number.isFinite(zoom)) return "full";

  if (previous === "overview") {
    if (zoom <= CANVAS_LOD_OVERVIEW_EXIT_ZOOM) return "overview";
    return zoom > CANVAS_LOD_GLYPH_EXIT_ZOOM ? "full" : "glyph";
  }

  if (zoom < CANVAS_LOD_OVERVIEW_ENTER_ZOOM) return "overview";
  if (previous === "glyph") {
    if (zoom > CANVAS_LOD_GLYPH_EXIT_ZOOM) return "full";
    return "glyph";
  }

  if (zoom < CANVAS_LOD_GLYPH_ENTER_ZOOM) return "glyph";
  return "full";
}

export function canvasBackgroundGapForZoom(baseGap: number, zoom: number): number {
  if (!Number.isFinite(baseGap) || baseGap <= 0) return 24;
  if (!Number.isFinite(zoom) || zoom >= 0.45) return baseGap;
  const safeZoom = Math.max(CANVAS_VIEWPORT_OVERVIEW_MIN_ZOOM, zoom);
  const targetScreenGap = safeZoom < 0.12 ? 28 : safeZoom < 0.3 ? 22 : 16;
  return Math.round(Math.max(baseGap, targetScreenGap / safeZoom));
}

export function canvasBackgroundSizeForZoom(baseSize: number, zoom: number): number {
  if (!Number.isFinite(baseSize) || baseSize <= 0) return 1;
  if (!Number.isFinite(zoom) || zoom >= 0.3) return baseSize;
  const safeZoom = Math.max(CANVAS_VIEWPORT_OVERVIEW_MIN_ZOOM, zoom);
  const targetScreenSize = safeZoom < 0.12 ? 1.15 : 0.9;
  return Math.round(Math.max(baseSize, targetScreenSize / safeZoom) * 10) / 10;
}

function roundBrowserBound(value: number): number {
  return Math.round(value * 2) / 2;
}

export function areCanvasBrowserBoundsEquivalent(
  previous: CanvasNativeBrowserBounds | null,
  next: CanvasNativeBrowserBounds,
): boolean {
  if (!previous) return false;
  return Math.abs(previous.x - next.x) < CANVAS_BROWSER_BOUNDS_EPSILON &&
    Math.abs(previous.y - next.y) < CANVAS_BROWSER_BOUNDS_EPSILON &&
    Math.abs(previous.width - next.width) < CANVAS_BROWSER_BOUNDS_EPSILON &&
    Math.abs(previous.height - next.height) < CANVAS_BROWSER_BOUNDS_EPSILON &&
    Math.abs((previous.zoomFactor ?? 1) - (next.zoomFactor ?? 1)) < 0.005;
}

export function canvasNativeBrowserBoundsFromRects(
  nodeRect: CanvasRectLike,
  clipRect: CanvasRectLike,
  viewportRect: CanvasRectLike,
): CanvasNativeBrowserBounds {
  // Tauri child WebViews sit above the DOM. Keep a small matte around the native
  // surface so ReactFlow's resize rails remain reachable and the WebView never
  // covers the node chrome during rapid zoom/pan/resize gestures.
  const left = Math.max(nodeRect.left + CANVAS_NATIVE_WEBVIEW_SAFE_INSET, viewportRect.left, clipRect.left);
  const top = Math.max(nodeRect.top + CANVAS_NATIVE_WEBVIEW_SAFE_INSET, viewportRect.top, clipRect.top);
  const right = Math.min(nodeRect.right - CANVAS_NATIVE_WEBVIEW_SAFE_INSET, viewportRect.right, clipRect.right);
  const bottom = Math.min(nodeRect.bottom - CANVAS_NATIVE_WEBVIEW_SAFE_INSET, viewportRect.bottom, clipRect.bottom);
  const width = right - left;
  const height = bottom - top;

  if (!Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < CANVAS_NATIVE_WEBVIEW_MIN_VISIBLE_SIZE ||
    height < CANVAS_NATIVE_WEBVIEW_MIN_VISIBLE_SIZE) {
    return CANVAS_BROWSER_PARKED_BOUNDS;
  }

  return {
    x: roundBrowserBound(left),
    y: roundBrowserBound(top),
    width: roundBrowserBound(width),
    height: roundBrowserBound(height),
  };
}

/** A docked occluder whose least cut removes more than this fraction of the clip is ignored. */
export const CANVAS_DOCKED_OCCLUDER_MAX_AREA_FRACTION = 0.4;

function rectArea(r: CanvasRectLike): number {
  return Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
}

function rectsIntersect(a: CanvasRectLike, b: CanvasRectLike): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Shrink `clipRect` so it no longer overlaps each docked occluder. A native WebView can only be
 * bounded by a single rect, so we cannot punch holes — instead, for each occluder we cut the ONE
 * clip edge whose retraction removes the least area while fully clearing the occluder. This is
 * exact for edge-docked UI (bottom command bar, right rail); a center-floating rect whose smallest
 * cut would remove more than CANVAS_DOCKED_OCCLUDER_MAX_AREA_FRACTION of the clip is left alone
 * (such UI should acquire a blocking occlusion lock instead of registering as docked).
 */
/** A docked occluder rect, optionally `force`d to clip past the area-fraction cap. */
export type CanvasDockedOccluderRect = CanvasRectLike & { force?: boolean };

export type CanvasDockedEdge = "top" | "bottom" | "left" | "right";

/**
 * Expand a floating rect into a full viewport-edge strip anchored to `edge`. A dropdown menu is a
 * corner rect, and a single least-area cut of a corner rect is ambiguous (bottom vs right) and can
 * leave the menu partly covered. Anchoring it to its docking edge makes the browser's clip a clean,
 * deterministic single-edge cut (the case docked clipping handles perfectly, like the command bar).
 */
export function dockedOccluderEdgeStrip(
  rect: CanvasRectLike,
  edge: CanvasDockedEdge,
  viewport: CanvasRectLike,
): CanvasRectLike {
  switch (edge) {
    case "bottom":
      return { left: viewport.left, top: rect.top, right: viewport.right, bottom: viewport.bottom };
    case "top":
      return { left: viewport.left, top: viewport.top, right: viewport.right, bottom: rect.bottom };
    case "left":
      return { left: viewport.left, top: viewport.top, right: rect.right, bottom: viewport.bottom };
    case "right":
      return { left: rect.left, top: viewport.top, right: viewport.right, bottom: viewport.bottom };
  }
}

export function subtractDockedRects(
  clipRect: CanvasRectLike,
  dockedRects: ReadonlyArray<CanvasDockedOccluderRect>,
): CanvasRectLike {
  let clip: CanvasRectLike = { ...clipRect };

  for (const d of dockedRects) {
    if (!rectsIntersect(clip, d)) continue;
    const clipWidth = clip.right - clip.left;
    const clipHeight = clip.bottom - clip.top;

    const newBottom = Math.min(clip.bottom, Math.max(clip.top, d.top));
    const newTop = Math.max(clip.top, Math.min(clip.bottom, d.bottom));
    const newLeft = Math.max(clip.left, Math.min(clip.right, d.right));
    const newRight = Math.min(clip.right, Math.max(clip.left, d.left));

    const candidates = [
      { removed: clipWidth * (clip.bottom - newBottom), next: { ...clip, bottom: newBottom } },
      { removed: clipWidth * (newTop - clip.top), next: { ...clip, top: newTop } },
      { removed: clipHeight * (newLeft - clip.left), next: { ...clip, left: newLeft } },
      { removed: clipHeight * (clip.right - newRight), next: { ...clip, right: newRight } },
    ];

    const best = candidates.reduce((a, b) => (b.removed < a.removed ? b : a));
    // A `force`d occluder (an edge-anchored dropdown that MUST be cleared, not a
    // stray center-floating rect) always clips; the area cap only guards the
    // auto-registered docks (NL bar / rail) from over-clipping.
    const clipAreaNow = rectArea(clip);
    if (
      !d.force &&
      clipAreaNow > 0 &&
      best.removed > clipAreaNow * CANVAS_DOCKED_OCCLUDER_MAX_AREA_FRACTION
    ) {
      continue;
    }
    clip = best.next;
  }

  return clip;
}

/** True when bounds are parked / too small to show a page (the black-pane state). */
function isParkedBrowserBounds(b: CanvasNativeBrowserBounds): boolean {
  return b.width < CANVAS_NATIVE_WEBVIEW_MIN_VISIBLE_SIZE || b.height < CANVAS_NATIVE_WEBVIEW_MIN_VISIBLE_SIZE;
}

/**
 * Choose between the full bounds (ignoring docked UI) and the docked-avoided bounds.
 *
 * Docked-occluder avoidance is a cosmetic nicety — it keeps the native WebView from
 * covering the NL command bar / tool rail. It must NEVER black out a browser that
 * would otherwise be visible: if avoidance collapses to a park while the full bounds
 * are healthy, keep the full bounds and let the occluder overlap. A browser that
 * slightly underlaps a bottom bar is strictly better than an all-black pane.
 */
export function preferVisibleBrowserBounds(
  full: CanvasNativeBrowserBounds,
  avoided: CanvasNativeBrowserBounds,
): CanvasNativeBrowserBounds {
  if (isParkedBrowserBounds(avoided) && !isParkedBrowserBounds(full)) return full;
  return avoided;
}

/**
 * Full native-bounds math including docked-occluder avoidance: subtract any docked UI from the clip
 * rect, then compute the visible WebView bounds. The single seam the bounds-sync hook calls.
 *
 * Docked avoidance is best-effort: {@link preferVisibleBrowserBounds} guarantees it can never
 * black out a browser that would otherwise be visible.
 */
export function canvasVisibleBrowserBoundsFromRects(
  nodeRect: CanvasRectLike,
  clipRect: CanvasRectLike,
  viewportRect: CanvasRectLike,
  dockedRects: ReadonlyArray<CanvasDockedOccluderRect>,
): CanvasNativeBrowserBounds {
  const full = canvasNativeBrowserBoundsFromRects(nodeRect, clipRect, viewportRect);
  if (!dockedRects.length) return full;
  const avoided = canvasNativeBrowserBoundsFromRects(
    nodeRect,
    subtractDockedRects(clipRect, dockedRects),
    viewportRect,
  );
  return preferVisibleBrowserBounds(full, avoided);
}

export function canvasBrowserBoundsSyncDelayMs(nowMs: number, lastSyncMs: number | null): number {
  if (lastSyncMs == null) return 0;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastSyncMs)) return 0;
  return Math.max(0, CANVAS_BROWSER_BOUNDS_SYNC_THROTTLE_MS - (nowMs - lastSyncMs));
}

/** Backoff schedule (ms) for retrying a failed park. Returns null once retries are exhausted. */
export const CANVAS_PARK_RETRY_DELAYS_MS: readonly number[] = [50, 150, 400];

export function canvasParkRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return CANVAS_PARK_RETRY_DELAYS_MS[attempt] ?? null;
}

export function shouldSuspendCanvasNativeOverlay({ dragging, resizing, lodTier, overlayBlocked }: CanvasNativeOverlayPolicyInput): boolean {
  return Boolean(dragging || resizing || lodTier !== "full" || overlayBlocked);
}

/**
 * When a native browser WebView is parked for a blocking overlay, keyboard focus may still live in
 * that child WebView — so the overlay's own key handlers (e.g. Escape to close) never fire. Return
 * focus to the main WebView, but only for overlay parks (not transient gesture/LOD parks) and only
 * when a live browser could actually be holding focus.
 */
export function shouldReturnFocusToMainWebview(input: { overlayBlocked: boolean; browserActive: boolean }): boolean {
  return input.overlayBlocked && input.browserActive;
}
