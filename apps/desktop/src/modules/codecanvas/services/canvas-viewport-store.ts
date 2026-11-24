import type { Viewport } from "@xyflow/react";
import {
  canvasClampZoom,
  canvasViewportZoomBoundsForNodeCount,
  readableCanvasViewport,
  CANVAS_VIEWPORT_MAX_ZOOM,
  CANVAS_VIEWPORT_MIN_ZOOM,
  CANVAS_VIEWPORT_OVERVIEW_MIN_ZOOM,
  type CanvasViewportZoomBounds,
} from "./viewport/canvas-viewport-policy";

export {
  canvasClampZoom,
  canvasViewportZoomBoundsForNodeCount,
  CANVAS_VIEWPORT_MAX_ZOOM,
  CANVAS_VIEWPORT_MIN_ZOOM,
  CANVAS_VIEWPORT_OVERVIEW_MIN_ZOOM,
  type CanvasViewportZoomBounds,
};

const STORAGE_PREFIX = "lotus.codecanvas.viewport.";
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export type CanvasViewportMode = "board" | "fleet";

function storageKey(projectId: string, mode: CanvasViewportMode): string {
  return `${STORAGE_PREFIX}${projectId}${mode === "fleet" ? ".fleet" : ""}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function loadCanvasViewport(projectId: string | null | undefined, bounds?: CanvasViewportZoomBounds, mode: CanvasViewportMode = "board"): Viewport | null {
  if (!projectId || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(projectId, mode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Viewport>;
    if (!isFiniteNumber(parsed.x) || !isFiniteNumber(parsed.y) || !isFiniteNumber(parsed.zoom)) return null;
    return readableCanvasViewport({ x: parsed.x, y: parsed.y, zoom: parsed.zoom }, bounds);
  } catch {
    return null;
  }
}

export function saveCanvasViewport(projectId: string | null | undefined, viewport: Viewport, bounds?: CanvasViewportZoomBounds, mode: CanvasViewportMode = "board"): void {
  if (!projectId || typeof localStorage === "undefined") return;
  if (!isFiniteNumber(viewport.x) || !isFiniteNumber(viewport.y) || !isFiniteNumber(viewport.zoom)) return;
  try {
    localStorage.setItem(storageKey(projectId, mode), JSON.stringify(readableCanvasViewport(viewport, bounds)));
  } catch {
    // Viewport persistence is best-effort; a storage failure must not break canvas gestures.
  }
}

export function viewportForCanvasProject(projectId: string | null | undefined, bounds?: CanvasViewportZoomBounds, mode: CanvasViewportMode = "board"): Viewport {
  return loadCanvasViewport(projectId, bounds, mode) ?? DEFAULT_VIEWPORT;
}
