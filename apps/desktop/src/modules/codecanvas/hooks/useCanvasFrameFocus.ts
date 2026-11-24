"use client";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { ARRANGE_ANIM_MS } from "../services/canvas-arrange";
import { canvasActiveFrameStore, nearestFrameId, resolveActiveFrameId } from "../services/canvas-active-frame";
import { frameBounds } from "../services/canvas-frame-switcher";
import { canvasFrameRetileStore } from "../services/canvas-frame-retile-store";
import { canvasFrameOverviewStore } from "../services/canvas-frame-overview-store";
import { planFrameRetile, type FrameFocusRecord, type RetileIntent } from "../services/canvas-frame-retile";
import { frameIdOf, framesInOrder, isFrameNode } from "../services/canvas-frames";
import { CANVAS_MOTION, TIDY_DEBOUNCE_MS, canvasEaseOutQuint, canvasMotionEnabled, holdCanvasArrangeGlide } from "../services/canvas-motion";
import { runCanvasViewportMotion } from "../services/viewport/canvas-viewport-motion";
import { frameBoundsInVisibleArea, measureVisibleCanvasArea } from "../services/viewport/canvas-visible-frame";
import { getCanvasBehaviorSettings } from "./useCanvasBehaviorSettings";
import { boundsWithRunMargin, fitInsideRunMargin, runGroupArrangeMargin } from "../services/run-group";

type LayoutBounds = { minX: number; minY: number; width: number; height: number };

interface Deps {
  flowInstance: ReactFlowInstance | null;
  nodes: Node[];
  /** Always-current nodes, for timers and callbacks that outlive a render. */
  nodesRef: MutableRefObject<Node[]>;
  /** One key per canvas (project): the active Frame and the focus record are per canvas. */
  canvasKey: string;
  /** False while the board is mid-swap: its nodes are not this canvas's, so nothing may be inferred from them. */
  boardReady: boolean;
  focusedNodeIdRef: MutableRefObject<string | null>;
  exitFocus: (opts: { restore: boolean }) => void;
  /** Tile ONLY the Frame's members to fill `fit` (decision 35); null when there is nothing to tile. */
  arrangeFrameMembers: (frameId: string, fit: { width: number; height: number }) => LayoutBounds | null;
  /** Re-tile the members inside the Frame's current box, camera untouched (decision 39). */
  retileFrameMembers: (frameId: string) => LayoutBounds | null;
}

const intentRank = (i: RetileIntent | null) => (i?.kind === "open" ? 2 : i ? 1 : 0);
const strongerIntent = (a: RetileIntent | null, b: RetileIntent | null) => (intentRank(b) >= intentRank(a) ? b : a);

const glideMs = () => (canvasMotionEnabled() ? Math.max(ARRANGE_ANIM_MS, CANVAS_MOTION.reframeMs) : 0);

/**
 * Frame focus, the Active Frame and the member re-tile, in one place so CanvasPage stays shallow.
 *
 * - `focusFrame` is the ONE path every "fly to a Frame" goes through (chips, ⌥1-9, Overview, NL
 *   "buka X"): decision 35 layout + camera, and the Frame becomes active (decision 36).
 * - Member add/close arrives through `canvasFrameRetileStore` and is coalesced into one re-tile per
 *   burst. Auto-tidy on (decision 47): an open or close in the active Frame refills the screen with it.
 *   Otherwise (decision 39): focused Frame -> refill the screen with the
 *   camera staying on it; any other Frame -> re-tile inside its box, camera untouched. Nothing here ever
 *   arranges the whole canvas.
 */
export function useCanvasFrameFocus(deps: Deps) {
  const { nodes, canvasKey, boardReady } = deps;
  // Latest-value refs so timers and subscriptions never close over a stale render.
  const depsRef = useRef(deps);
  useLayoutEffect(() => { depsRef.current = deps; });

  const focusRef = useRef<FrameFocusRecord | null>(null);
  // Frame id -> the strongest intent announced for it in this burst (open > close > unknown).
  const pendingRef = useRef<Map<string, RetileIntent | null>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusTokenRef = useRef(0);

  const activateFrame = useCallback((frameId: string) => {
    const d = depsRef.current;
    if (!framesInOrder(d.nodesRef.current).some((f) => f.id === frameId)) return;
    canvasActiveFrameStore.set(d.canvasKey, frameId);
  }, []);

  const noteNodeInteraction = useCallback((node: Node) => {
    if (isFrameNode(node)) activateFrame(node.id);
    else {
      const fid = frameIdOf(node);
      if (fid) activateFrame(fid);
    }
  }, [activateFrame]);

  /** Tile the Frame's members to fill the visible area and frame the camera on them (decision 35). */
  const flyToFrame = useCallback((frameId: string) => {
    const d = depsRef.current;
    const flow = d.flowInstance;
    const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
    const frame = d.nodesRef.current.find((n) => n.id === frameId && isFrameNode(n));
    if (!flow || !pane || !frame) return;
    const duration = glideMs();
    const chrome = getCanvasBehaviorSettings();
    const area = measureVisibleCanvasArea(pane.getBoundingClientRect(), {
      showToolRail: chrome.showToolRail,
      topControls: chrome.topControls,
    });
    holdCanvasArrangeGlide(duration);
    const token = ++focusTokenRef.current;
    // An open Run Node among the members draws its outline and header outside them (#74): keep room.
    const margin = runGroupArrangeMargin(d.nodesRef.current, (n) => frameIdOf(n) === frameId);
    const grid = d.arrangeFrameMembers(frameId, fitInsideRunMargin(area, margin));
    const bounds = grid ? boundsWithRunMargin(grid, margin) : null;
    if (!bounds) {
      // Nothing to tile: fit the Frame box itself, still without padding. The glide's end state is the
      // camera target, so it is read once the glide settles (until then the Frame does not count as focused).
      focusRef.current = { frameId, viewport: null, settledAt: Infinity };
      void Promise.resolve(flow.fitBounds(frameBounds(frame), { padding: 0, duration })).then(() => {
        if (focusTokenRef.current !== token) return;
        focusRef.current = { frameId, viewport: flow.getViewport(), settledAt: 0 };
      });
      return;
    }
    const target = frameBoundsInVisibleArea(bounds, area);
    focusRef.current = { frameId, viewport: target, settledAt: performance.now() + duration };
    void runCanvasViewportMotion(
      { currentZoom: flow.getViewport().zoom, durationMs: duration },
      () => flow.setViewport(target, { duration, ease: canvasEaseOutQuint, interpolate: "smooth" }),
    );
  }, []);

  /** Fly the camera to a Frame. Not an undo step: the re-tile is an automatic layout (canvas-board-marks). */
  const focusFrame = useCallback((frameId: string) => {
    const d = depsRef.current;
    if (!d.flowInstance) return;
    if (d.focusedNodeIdRef.current) d.exitFocus({ restore: false });
    if (!d.nodesRef.current.some((n) => n.id === frameId && isFrameNode(n))) return;
    canvasActiveFrameStore.set(d.canvasKey, frameId);
    flyToFrame(frameId);
  }, [flyToFrame]);

  // ── Member add/close -> one debounced re-tile ──
  const flushRef = useRef<() => void>(() => {});
  const flush = useCallback(() => {
    timerRef.current = undefined;
    const d = depsRef.current;
    const flow = d.flowInstance;
    const batch = [...pendingRef.current];
    pendingRef.current.clear();
    if (!flow) return;
    const flags = getCanvasBehaviorSettings();
    const activeFrameId = canvasActiveFrameStore.get(d.canvasKey);
    let wait = 0;
    let focusedFrame: string | null = null;
    for (const [frameId, intent] of batch) {
      const plan = planFrameRetile({
        frameId,
        nodes: d.nodesRef.current,
        focus: focusRef.current,
        viewport: flow.getViewport(),
        nodeFocused: Boolean(d.focusedNodeIdRef.current),
        now: performance.now(),
        intent,
        flags,
        activeFrameId,
        overviewOpen: canvasFrameOverviewStore.get().active,
      });
      if (plan.mode === "wait") {
        pendingRef.current.set(frameId, intent);
        wait = Math.max(wait, plan.ms);
      } else if (plan.mode === "focused") {
        focusedFrame = plan.frameId;
      } else if (plan.mode === "in-box") {
        holdCanvasArrangeGlide(glideMs());
        d.retileFrameMembers(plan.frameId);
      }
    }
    if (focusedFrame) flyToFrame(focusedFrame);
    if (pendingRef.current.size > 0) timerRef.current = setTimeout(() => flushRef.current(), wait + 16);
  }, [flyToFrame]);
  useEffect(() => { flushRef.current = flush; }, [flush]);

  useEffect(() => canvasFrameRetileStore.subscribe((frameId, intent) => {
    pendingRef.current.set(frameId, strongerIntent(pendingRef.current.get(frameId) ?? null, intent ?? null));
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, TIDY_DEBOUNCE_MS);
  }), [flush]);

  useEffect(() => () => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pendingRef.current.clear();
  }, []);

  // A different canvas has its own camera and its own Frames.
  useEffect(() => {
    focusRef.current = null;
    focusTokenRef.current += 1;
    pendingRef.current.clear();
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, [canvasKey]);

  // ── Active Frame upkeep (decision 36) ──
  const prevFramesRef = useRef<{ key: string; frames: Map<string, Node> }>({ key: canvasKey, frames: new Map() });
  useEffect(() => {
    if (!boardReady) {
      prevFramesRef.current = { key: canvasKey, frames: new Map() };
      return;
    }
    const frames = framesInOrder(nodes);
    const prev = prevFramesRef.current.key === canvasKey ? prevFramesRef.current.frames : new Map<string, Node>();
    prevFramesRef.current = { key: canvasKey, frames: new Map(frames.map((f) => [f.id, f])) };
    const stored = canvasActiveFrameStore.get(canvasKey);
    // A Frame that just vanished hands "active" to its nearest neighbour; otherwise validate / fall back.
    const vanished = stored && !frames.some((f) => f.id === stored) ? prev.get(stored) : undefined;
    const next = vanished ? nearestFrameId(frames, vanished) : resolveActiveFrameId(nodes, stored);
    // No Frames: keep the saved id untouched (the board may simply not be hydrated yet).
    if (next && next !== stored) canvasActiveFrameStore.set(canvasKey, next);
  }, [nodes, canvasKey, boardReady]);

  // Selecting a member (click, drag start, keyboard navigation) or a Frame's own tab makes that Frame active.
  // Keyed on the selected id so panning/dragging churn never re-fires it and an explicit focus is not undone.
  let selectedId: string | null = null;
  let selectedCount = 0;
  for (const n of nodes) {
    if (n.selected) {
      selectedCount += 1;
      selectedId = n.id;
    }
  }
  const soleSelectedId = selectedCount === 1 ? selectedId : null;
  useEffect(() => {
    if (!soleSelectedId || !boardReady) return;
    const node = depsRef.current.nodesRef.current.find((n) => n.id === soleSelectedId);
    if (node) noteNodeInteraction(node);
  }, [soleSelectedId, boardReady, noteNodeInteraction]);

  return { focusFrame, activateFrame, noteNodeInteraction };
}
