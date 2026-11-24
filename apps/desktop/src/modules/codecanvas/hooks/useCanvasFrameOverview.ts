"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node, ReactFlowInstance, Viewport } from "@xyflow/react";
import { CANVAS_MOTION, canvasEaseOutQuint, canvasMotionDuration } from "../services/canvas-motion";
import { canvasFrameOverviewStore } from "../services/canvas-frame-overview-store";
import {
  fitBoundsInArea,
  buildFrameOverviewLabels,
  moveFrameFocus,
  overviewBounds,
  type OverviewDirection,
} from "../services/canvas-frame-overview";
import { overviewFullDetail } from "../services/canvas-frame-grid";
import { framesInOrder, isFrameNode } from "../services/canvas-frames";
import type { AgentStatusSnapshot } from "../services/agent-status-registry";
import { isEditableCanvasKeyTarget } from "../services/canvas-keyboard-guard";
import { runCanvasViewportMotion } from "../services/viewport/canvas-viewport-motion";
import { measureVisibleCanvasArea } from "../services/viewport/canvas-visible-frame";
import { getCanvasBehaviorSettings } from "./useCanvasBehaviorSettings";

const ARROWS: Record<string, OverviewDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

interface Options {
  flowInstance: ReactFlowInstance<Node, Edge> | null;
  nodes: Node[];
  /** Live agent statuses: the same feed the Frame Switcher chips roll up. */
  statuses: ReadonlyArray<Pick<AgentStatusSnapshot, "id" | "status">>;
  zoomBounds: { minZoom: number; maxZoom: number };
  /** Changes when the active canvas does; the overview closes without restoring a stale viewport. */
  canvasKey: string | null;
  /** Focus a Frame (decision 35): the same function the switcher chips and ⌥N use. */
  focusFrame: (frameId: string) => void;
  /**
   * Snap every Frame into the Frame Grid (decision 43), optionally swapping two Frames' numbers. Returns the grid's
   * bounds so the camera can fit it; null without Frames or a pane. Absent: the Overview fits the Frames where they are.
   */
  snapFrameGrid?: (swap?: readonly [string, string]) => { bounds: { minX: number; minY: number; width: number; height: number } } | null;
  /** The active Frame of this canvas (decision 36): lit first, and where Esc returns to once the grid has moved things. */
  activeFrameId?: () => string | null;
}

/** Even breathing room around the grid, screen px. */
const OVERVIEW_MARGIN = 20;

/**
 * Frame Overview controller (ADR-0050, LOT2-125). Grid button toggles it: the camera glides out to
 * every Frame (plus loose nodes), the previous viewport is remembered, Esc or the button again
 * glides back, Enter or a click flies into a Frame. While open, nodes are not interactive (the
 * overlay layer swallows pointer events), so a click can only mean "go there".
 */
export function useCanvasFrameOverview({ flowInstance, nodes, statuses, zoomBounds, canvasKey, focusFrame, snapFrameGrid, activeFrameId }: Options) {
  const [active, setActive] = useState(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const previousViewportRef = useRef<Viewport | null>(null);
  const activeRef = useRef(false);
  /** The grid moved Frames since the viewport was remembered, so that viewport no longer points at them. */
  const snappedRef = useRef(false);
  const snapRef = useRef(snapFrameGrid);
  snapRef.current = snapFrameGrid;
  const activeFrameRef = useRef(activeFrameId);
  activeFrameRef.current = activeFrameId;
  // A ref, not a dependency: `close` is the unmount/canvas-switch cleanup's identity, and a caller passing a
  // fresh `focusFrame` each render must not close the Overview under the user.
  const focusFrameRef = useRef(focusFrame);
  focusFrameRef.current = focusFrame;

  const glideTo = useCallback(
    (target: Viewport) => {
      if (!flowInstance) return;
      const current = flowInstance.getViewport();
      const duration = canvasMotionDuration(CANVAS_MOTION.fitMs);
      void runCanvasViewportMotion(
        { currentZoom: current.zoom, durationMs: duration },
        () => flowInstance.setViewport(target, { duration, ease: canvasEaseOutQuint, interpolate: "smooth" }),
      );
    },
    [flowInstance],
  );

  const fit = useCallback(
    (bounds: { minX: number; minY: number; width: number; height: number }): Viewport | null => {
      const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
      if (!pane) return null;
      const chrome = getCanvasBehaviorSettings();
      const area = measureVisibleCanvasArea(pane.getBoundingClientRect(), {
        showToolRail: chrome.showToolRail,
        topControls: chrome.topControls,
      });
      return fitBoundsInArea(bounds, area, { minZoom: zoomBounds.minZoom, maxZoom: 1, margin: OVERVIEW_MARGIN });
    },
    [zoomBounds.minZoom],
  );

  const close = useCallback(
    (restore: boolean) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      const previous = previousViewportRef.current;
      previousViewportRef.current = null;
      const snapped = snappedRef.current;
      snappedRef.current = false;
      canvasFrameOverviewStore.close();
      setActive(false);
      if (!restore) return;
      // The grid moved the Frames: the old viewport looks at empty canvas. Go back to the active Frame instead.
      const active = snapped ? activeFrameRef.current?.() ?? null : null;
      if (active && nodesRef.current.some((n) => n.id === active && isFrameNode(n))) focusFrameRef.current(active);
      else if (previous) glideTo(previous);
    },
    [glideTo],
  );

  const open = useCallback(() => {
    if (!flowInstance || activeRef.current) return;
    const frames = framesInOrder(nodesRef.current);
    const previous = flowInstance.getViewport();
    // Decision 43: the Frames snap into their grid slots (animated) and the camera fits the grid, not
    // wherever the Frames happened to be.
    const snap = frames.length > 0 ? snapRef.current?.() ?? null : null;
    const bounds = snap?.bounds ?? overviewBounds(nodesRef.current);
    if (!bounds) return;
    const target = fit(bounds);
    if (!target) return;
    const labels = buildFrameOverviewLabels(nodesRef.current, statusesRef.current);
    const active = activeFrameRef.current?.() ?? null;
    previousViewportRef.current = previous;
    snappedRef.current = snap !== null;
    activeRef.current = true;
    canvasFrameOverviewStore.open(
      labels,
      frames.some((f) => f.id === active) ? active : frames[0]?.id ?? null,
      overviewFullDetail(nodesRef.current),
    );
    setActive(true);
    glideTo(target);
  }, [flowInstance, fit, glideTo]);

  // Decision 43: dropping a Frame on another slot swaps the two; both glide into each other's slot.
  const swap = useCallback((aId: string, bId: string) => {
    if (!activeRef.current || aId === bId) return;
    snapRef.current?.([aId, bId]);
    snappedRef.current = true;
  }, []);

  const toggle = useCallback(() => {
    if (activeRef.current) close(true);
    else open();
  }, [close, open]);

  const flyIn = useCallback(
    (frameId: string) => {
      if (!nodesRef.current.some((n) => n.id === frameId && isFrameNode(n))) return;
      // Entering a Frame replaces the remembered viewport: the user chose a new place to be.
      close(false);
      focusFrame(frameId);
    },
    [close, focusFrame],
  );

  // Live while open (decision 42): the labels were a snapshot taken at open, so a node spawned or an agent
  // turning "needs you" under the Overview left stale numbers. The store skips the commit when nothing changed.
  useEffect(() => {
    if (!active) return;
    canvasFrameOverviewStore.setLabels(buildFrameOverviewLabels(nodes, statuses));
    canvasFrameOverviewStore.setFullDetail(overviewFullDetail(nodes));
  }, [active, nodes, statuses]);

  const focus = useCallback((id: string | null) => canvasFrameOverviewStore.focus(id), []);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (isEditableCanvasKeyTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      const dir = ARROWS[event.key];
      if (dir) {
        event.preventDefault();
        const frames = framesInOrder(nodesRef.current);
        canvasFrameOverviewStore.focus(moveFrameFocus(frames, canvasFrameOverviewStore.get().focusedId, dir));
        return;
      }
      if (event.key === "Enter") {
        const id = canvasFrameOverviewStore.get().focusedId;
        if (!id) return;
        event.preventDefault();
        flyIn(id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, close, flyIn]);

  // Switching canvas while open: the remembered viewport belongs to the other canvas.
  useEffect(() => () => close(false), [canvasKey, close]);

  return { active, toggle, exit: () => close(true), flyIn, focus, swap };
}
