import { canvasLodTierWithHysteresis, type CanvasLodTier } from "./canvas-viewport-policy";

export interface CanvasViewportFrame {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasScreenPoint {
  x: number;
  y: number;
}

export interface CanvasViewportRect {
  width: number;
  height: number;
}

export interface CanvasViewportMotionSnapshot {
  active: boolean;
  frozenLodTier: CanvasLodTier | null;
  version: number;
}

export interface CanvasViewportMotionRunOptions {
  currentZoom?: number;
  durationMs: number;
  settleMs?: number;
}

const IDLE_VIEWPORT_MOTION: CanvasViewportMotionSnapshot = { active: false, frozenLodTier: null, version: 0 };

let viewportMotionSnapshot: CanvasViewportMotionSnapshot = IDLE_VIEWPORT_MOTION;
let stableLodTier: CanvasLodTier = "full";
let activeMotionToken = 0;
const viewportMotionListeners = new Set<() => void>();

function emitViewportMotionChange() {
  viewportMotionListeners.forEach((listener) => listener());
}

export function getCanvasViewportMotionSnapshot(): CanvasViewportMotionSnapshot {
  return viewportMotionSnapshot;
}

export function subscribeCanvasViewportMotion(listener: () => void): () => void {
  viewportMotionListeners.add(listener);
  return () => viewportMotionListeners.delete(listener);
}

export function setCanvasViewportStableLodTier(tier: CanvasLodTier) {
  stableLodTier = tier;
}

export function resolveCanvasLodTierDuringViewportMotion(
  zoom: number,
  previous: CanvasLodTier,
  snapshot: CanvasViewportMotionSnapshot = viewportMotionSnapshot,
): CanvasLodTier {
  if (snapshot.active && snapshot.frozenLodTier) return snapshot.frozenLodTier;
  return canvasLodTierWithHysteresis(zoom, previous);
}

export function beginCanvasViewportMotion({ currentZoom, durationMs, settleMs = 90 }: CanvasViewportMotionRunOptions): () => void {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const token = ++activeMotionToken;
  if (duration <= 0) {
    if (viewportMotionSnapshot.active) {
      viewportMotionSnapshot = { active: false, frozenLodTier: null, version: viewportMotionSnapshot.version + 1 };
      emitViewportMotionChange();
    }
    return () => {};
  }

  const frozenLodTier = Number.isFinite(currentZoom)
    ? canvasLodTierWithHysteresis(currentZoom as number, stableLodTier)
    : stableLodTier;
  viewportMotionSnapshot = { active: true, frozenLodTier, version: viewportMotionSnapshot.version + 1 };
  emitViewportMotionChange();

  let done = false;
  const finish = () => {
    if (done || token !== activeMotionToken) return;
    done = true;
    viewportMotionSnapshot = { active: false, frozenLodTier: null, version: viewportMotionSnapshot.version + 1 };
    emitViewportMotionChange();
  };
  const timer = setTimeout(finish, duration + Math.max(0, settleMs));
  return () => {
    clearTimeout(timer);
    finish();
  };
}

export function runCanvasViewportMotion<T>(
  options: CanvasViewportMotionRunOptions,
  run: () => T | Promise<T>,
): Promise<T> {
  const finish = beginCanvasViewportMotion(options);
  try {
    return Promise.resolve(run()).finally(finish);
  } catch (error) {
    finish();
    throw error;
  }
}

export function resetCanvasViewportMotionForTests() {
  viewportMotionSnapshot = IDLE_VIEWPORT_MOTION;
  stableLodTier = "full";
  activeMotionToken = 0;
  viewportMotionListeners.clear();
}

export function viewportForZoomAroundPoint(
  viewport: CanvasViewportFrame,
  nextZoom: number,
  point: CanvasScreenPoint,
): CanvasViewportFrame {
  const safeCurrentZoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const safeNextZoom = Number.isFinite(nextZoom) && nextZoom > 0 ? nextZoom : safeCurrentZoom;
  const flowX = (point.x - viewport.x) / safeCurrentZoom;
  const flowY = (point.y - viewport.y) / safeCurrentZoom;
  return {
    x: point.x - flowX * safeNextZoom,
    y: point.y - flowY * safeNextZoom,
    zoom: safeNextZoom,
  };
}

export function viewportForZoomAroundRectCenter(
  viewport: CanvasViewportFrame,
  nextZoom: number,
  rect: CanvasViewportRect,
): CanvasViewportFrame {
  return viewportForZoomAroundPoint(viewport, nextZoom, { x: rect.width / 2, y: rect.height / 2 });
}
