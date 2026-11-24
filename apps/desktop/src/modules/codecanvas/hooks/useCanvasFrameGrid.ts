"use client";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { ARRANGE_ANIM_MS } from "../services/canvas-arrange";
import { canvasFrameOverviewStore } from "../services/canvas-frame-overview-store";
import { framesInOrder } from "../services/canvas-frames";
import { frameBoxOf } from "../services/canvas-frame-space";
import { frameGridLayout } from "../services/canvas-frame-grid";
import { CANVAS_MOTION, canvasMotionEnabled, holdCanvasArrangeGlide } from "../services/canvas-motion";
import { measureVisibleCanvasArea, type LayoutBounds } from "../services/viewport/canvas-visible-frame";
import { getCanvasBehaviorSettings } from "./useCanvasBehaviorSettings";
import { isRestoreBoard } from "../services/canvas-board-marks";

interface Deps {
  nodes: Node[];
  /** Always-current nodes, for effects that outlive a render. */
  nodesRef: MutableRefObject<Node[]>;
  /** One key per canvas: the first Frame set seen on a canvas is the baseline, never snapped. */
  canvasKey: string;
  /** False while the board is mid-swap: its nodes are not this canvas's. */
  boardReady: boolean;
  /** Plan + apply the Frame Grid (useCanvasNodes). Returns the grid's bounds, null without Frames. */
  applyFrameGrid: (slot: { width: number; height: number }, swap?: readonly [string, string]) => LayoutBounds | null;
  /** Node focus (hero + rail) owns the layout: an automatic snap waits until it ends. */
  focusedNodeIdRef?: MutableRefObject<string | null>;
  /** When given, an automatic snap carries the camera along with the Frame it was looking at. */
  flowInstance?: ReactFlowInstance | null;
}

export interface FrameGridSnap {
  bounds: LayoutBounds;
  slot: { width: number; height: number };
}

const glideMs = () => (canvasMotionEnabled() ? Math.max(ARRANGE_ANIM_MS, CANVAS_MOTION.reframeMs) : 0);

/** A slot is the visible canvas area at zoom 1: what a focused Frame fills (decision 35). */
export function measureFrameSlot(): { width: number; height: number } | null {
  const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
  if (!pane) return null;
  const chrome = getCanvasBehaviorSettings();
  const area = measureVisibleCanvasArea(pane.getBoundingClientRect(), {
    showToolRail: chrome.showToolRail,
    topControls: chrome.topControls,
  });
  return { width: area.width, height: area.height };
}

/** Order-free identity of the Frame set: a create or a delete changes it, a swap does not. */
const frameSetKey = (nodes: readonly Node[]) =>
  framesInOrder(nodes)
    .map((f) => f.id)
    .sort()
    .join("|");

/**
 * Frame Grid wiring (decisions 43-44), kept out of CanvasPage. `snapFrameGrid` animates every Frame into
 * its slot (the Overview calls it when it opens, and with `swap` when a Frame is dropped on another slot).
 * Creating or deleting a Frame snaps too. The Overview animates its own nodes, so no snap fires while it is
 * open, and a canvas's first Frame set is the baseline: opening an old canvas never rearranges it.
 */
export function useCanvasFrameGrid({ nodes, nodesRef, canvasKey, boardReady, applyFrameGrid, focusedNodeIdRef, flowInstance }: Deps) {
  const depsRef = useRef({ applyFrameGrid, flowInstance });
  useLayoutEffect(() => {
    depsRef.current = { applyFrameGrid, flowInstance };
  });

  const snapFrameGrid = useCallback((swap?: readonly [string, string]): FrameGridSnap | null => {
    const slot = measureFrameSlot();
    if (!slot) return null;
    holdCanvasArrangeGlide(glideMs());
    const bounds = depsRef.current.applyFrameGrid(slot, swap);
    return bounds ? { bounds, slot } : null;
  }, []);

  const seenRef = useRef<{ key: string; set: string } | null>(null);
  useEffect(() => {
    if (!boardReady) {
      seenRef.current = null;
      return;
    }
    const set = frameSetKey(nodes);
    const seen = seenRef.current;
    const settle = () => { seenRef.current = { key: canvasKey, set }; };
    if (!seen || seen.key !== canvasKey || seen.set === set || set === "") return settle();
    // An undo/redo put this Frame set back as it was: snapping over it would record a step and wipe redo.
    if (isRestoreBoard(nodes)) return settle();
    if (canvasFrameOverviewStore.get().active || nodesRef.current.length === 0) return settle();
    // Node focus owns the layout: leave the change unseen, so the snap runs on the board change its exit makes.
    if (focusedNodeIdRef?.current) return;
    settle();
    const follow = frameUnderCamera(depsRef.current.flowInstance, nodesRef.current);
    const snap = snapFrameGrid();
    if (follow && snap) followFrame(follow.flow, follow.frame, frameGridLayout(nodesRef.current, snap.slot)?.boxes.get(follow.frame.id));
  }, [nodes, nodesRef, canvasKey, boardReady, snapFrameGrid, focusedNodeIdRef]);

  return { snapFrameGrid };
}

/** The Frame under the centre of the screen, if any: the one the user is looking at. */
function frameUnderCamera(flow: ReactFlowInstance | null | undefined, nodes: readonly Node[]): { flow: ReactFlowInstance; frame: Node } | null {
  const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
  if (!flow || !pane) return null;
  const rect = pane.getBoundingClientRect();
  const v = flow.getViewport();
  const cx = (rect.width / 2 - v.x) / v.zoom;
  const cy = (rect.height / 2 - v.y) / v.zoom;
  const frame = framesInOrder(nodes).find((f) => {
    const b = frameBoxOf(f);
    return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
  });
  return frame ? { flow, frame } : null;
}

/** Pan by the Frame's move, same zoom, on the snap's glide: the Frame stays where it was on screen. */
function followFrame(flow: ReactFlowInstance, frame: Node, target: { x: number; y: number } | undefined): void {
  if (!target) return;
  const dx = target.x - frame.position.x;
  const dy = target.y - frame.position.y;
  if (dx === 0 && dy === 0) return;
  const v = flow.getViewport();
  void flow.setViewport({ x: v.x - dx * v.zoom, y: v.y - dy * v.zoom, zoom: v.zoom }, { duration: glideMs() });
}
