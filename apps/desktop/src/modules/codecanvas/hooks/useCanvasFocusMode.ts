"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { ARRANGE_ANIM_MS, isTiledCanvasNode, type ArrangeBox } from "../services/canvas-arrange";
import { CANVAS_MOTION, canvasEaseOutQuint, canvasMotionEnabled, holdCanvasArrangeGlide } from "../services/canvas-motion";
import { runCanvasViewportMotion } from "../services/viewport/canvas-viewport-motion";
import {
  frameBoundsInVisibleArea,
  canvasDockInset,
  measureVisibleCanvasArea,
  type LayoutBounds,
  type VisibleCanvasArea,
} from "../services/viewport/canvas-visible-frame";
import { getCanvasBehaviorSettings } from "./useCanvasBehaviorSettings";

/** Headless/test fallback when the canvas pane can't be measured. */
const FALLBACK_FIT = { width: 1440, height: 900 };

export interface CanvasFocusSession {
  heroId: string;
  snapshot: Map<string, ArrangeBox>;
}

interface UseCanvasFocusModeOptions {
  flowInstance: ReactFlowInstance<Node, Edge> | null;
  nodes: Node[];
  /** Apply the hero + rail layout (useCanvasNodes.applyFocusLayout); returns the layout bounds. */
  applyFocusLayout: (heroId: string, fit: { width: number; height: number }) => LayoutBounds | null;
  captureLayoutSnapshot: () => Map<string, ArrangeBox>;
  /** `heroId` lets the board frame the hero's Frame rather than the whole snapshot. */
  restoreLayoutSnapshot: (snapshot: Map<string, ArrangeBox>, heroId?: string) => LayoutBounds | null;
  /**
   * Undo anything the focus layout did that is NOT a position — run on every exit, restoring or not.
   *
   * Restoring and un-doing are different concerns, and `exitFocus({ restore: false })` proves it:
   * `handleArrange` uses that form because the arrange about to run owns the final positions. The
   * fleet layout also HIDES every non-hero cell, and hiding was folded into the restore path, so
   * arrange skipped it — leaving the board with one visible node, a stale rail drawn at its old
   * coordinates, and arrange tiling cells nobody could see.
   */
  onLeaveFocus?: () => void;
  /**
   * Called with the hero's id whenever a focus layout is applied — entry, hero swap, and re-tile.
   *
   * Exists so "the hero is the selected node" can be an invariant of focus mode rather than a habit
   * of one caller. It was never explicit before because focus was only ever entered by
   * double-clicking a node's chrome, and ReactFlow selects a node on click — so the selection arrived
   * for free. Promoting from the fleet rail bypassed that, and `selectedNodeIdRef` is read straight
   * off `node.selected`: with nothing selected there is no selection border, and every gesture keyed
   * to the selection (Enter to dive in, close-node, toggle-focus, spatial nav) silently does nothing.
   * The board felt stuck rather than merely unfocused.
   */
  onHeroChange?: (nodeId: string) => void;
  /** The Canvas Dock's state, read when the hero is measured, so the hero stays clear of it. */
  readDock?: () => { open: boolean; wide: boolean };
}

/**
 * Focus mode state machine (rail kanan). Entering snapshots the board ONCE, morphs the focused
 * node into the hero and everyone else into the right rail; exiting restores the snapshot —
 * both rides the same glide + camera curve as arrange. Swapping heroes while focused keeps the
 * ORIGINAL snapshot so exit always returns to the pre-focus board. Esc exits (never while
 * typing). `refreshFocus` re-tiles the rail after node create/close so newborn nodes join it,
 * and exits cleanly when the hero itself was closed.
 */
export function useCanvasFocusMode({
  flowInstance,
  nodes,
  applyFocusLayout,
  captureLayoutSnapshot,
  restoreLayoutSnapshot,
  onLeaveFocus,
  onHeroChange,
  readDock,
}: UseCanvasFocusModeOptions) {
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  // Mirrors focusedNodeId for listeners/timers; kept in sync manually by enter/exit —
  // the ONLY places that change the state — so it never needs a render-time write.
  const focusedRef = useRef<string | null>(null);
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  const snapshotRef = useRef<Map<string, ArrangeBox> | null>(null);

  const captureNewNodes = useCallback(() => {
    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    const hasNewTile = nodesRef.current.some((node) => isTiledCanvasNode(node) && !snapshot.has(node.id));
    if (!hasNewTile) return;
    for (const [nodeId, box] of captureLayoutSnapshot()) {
      if (!snapshot.has(nodeId)) snapshot.set(nodeId, box);
    }
  }, [captureLayoutSnapshot]);

  const measureArea = useCallback((): VisibleCanvasArea | null => {
    const pane = typeof document !== "undefined" ? document.querySelector(".react-flow") : null;
    if (!pane) return null;
    // Same chrome-aware rule as handleArrange: a hidden rail / docked top pill
    // hands its strip back to the hero + rail layout.
    const chromeFlags = getCanvasBehaviorSettings();
    const paneRect = pane.getBoundingClientRect();
    return measureVisibleCanvasArea(paneRect, {
      showToolRail: chromeFlags.showToolRail,
      topControls: chromeFlags.topControls,
      // The hero is sized to what the open Dock leaves, not stretched underneath it.
      dockInset: readDock ? canvasDockInset(readDock(), paneRect.width) : 0,
    });
  }, [readDock]);

  const morphDuration = () => (canvasMotionEnabled() ? Math.max(ARRANGE_ANIM_MS, CANVAS_MOTION.reframeMs) : 0);

  // Camera reframe on the same curve as the node glide (mirrors handleArrange's coordination).
  const frameCamera = useCallback(
    (bounds: LayoutBounds | null, area: VisibleCanvasArea | null) => {
      if (!bounds || bounds.width === 0 || !area || !flowInstance) return;
      const duration = morphDuration();
      const target = frameBoundsInVisibleArea(bounds, area);
      const current = flowInstance.getViewport();
      void runCanvasViewportMotion(
        { currentZoom: current.zoom, durationMs: duration },
        () => flowInstance.setViewport(target, { duration, ease: canvasEaseOutQuint, interpolate: "smooth" }),
      );
    },
    [flowInstance],
  );

  const exitFocus = useCallback(
    (opts?: { restore?: boolean }) => {
      const heroId = focusedRef.current;
      if (!heroId) return;
      setFocusedNodeId(null);
      focusedRef.current = null;
      const snapshot = snapshotRef.current;
      snapshotRef.current = null;
      // Before the restore branch, because the `restore: false` caller needs this too.
      onLeaveFocus?.();
      if (opts?.restore === false || !snapshot || snapshot.size === 0) return;
      holdCanvasArrangeGlide(morphDuration());
      frameCamera(restoreLayoutSnapshot(snapshot, heroId), measureArea());
    },
    [frameCamera, measureArea, onLeaveFocus, restoreLayoutSnapshot],
  );

  // Enter focus on a node; re-invoking on the current hero exits (double-click toggles).
  const enterFocus = useCallback(
    (nodeId: string) => {
      if (focusedRef.current === nodeId) {
        exitFocus();
        return;
      }
      const firstEntry = focusedRef.current === null;
      if (firstEntry) snapshotRef.current = captureLayoutSnapshot();
      else captureNewNodes();
      const area = measureArea();
      const fit = area ? { width: area.width, height: area.height } : FALLBACK_FIT;
      holdCanvasArrangeGlide(morphDuration());
      const bounds = applyFocusLayout(nodeId, fit);
      if (!bounds) {
        // Not a tiled node (shape / unknown id) — nothing moved, don't enter the mode.
        if (firstEntry) snapshotRef.current = null;
        return;
      }
      setFocusedNodeId(nodeId);
      focusedRef.current = nodeId;
      onHeroChange?.(nodeId);
      frameCamera(bounds, area);
    },
    [applyFocusLayout, captureLayoutSnapshot, captureNewNodes, exitFocus, frameCamera, measureArea, onHeroChange],
  );

  /**
   * Make `nodeId` the hero, and never anything else.
   *
   * {@link enterFocus} is a TOGGLE — re-invoking it on the current hero exits, which is what lets a
   * double-click on a node's own chrome leave focus. A list row is not a chrome gesture: wiring the
   * fleet rail to that function meant click one promoted and click two dropped you out of focus, so
   * a double-click on a row dismissed the whole rail.
   *
   * Idempotent on purpose. Clicking the hero's own row does nothing, which is what makes a
   * double-click harmless rather than destructive.
   */
  const promoteFocus = useCallback(
    (nodeId: string) => {
      if (focusedRef.current === nodeId) return;
      enterFocus(nodeId);
    },
    [enterFocus],
  );

  // Re-tile after a node create/close while focused (the tidy chokepoint routes here):
  // newborn nodes join the rail; a closed hero exits back to the snapshot (minus itself).
  const refreshFocus = useCallback(() => {
    const heroId = focusedRef.current;
    if (!heroId) return;
    captureNewNodes();
    const heroAlive = nodesRef.current.some((n) => n.id === heroId && isTiledCanvasNode(n));
    if (!heroAlive) {
      snapshotRef.current?.delete(heroId);
      // The hero was closed. Hand focus to the next cell rather than tearing the view down — the
      // fleet rail lists the hero with its own close button, so exiting here meant closing one agent
      // dismantled the panel you were working in. A closed tab moves to the next tab; it does not
      // close the window.
      const next = nodesRef.current.find((n) => n.id !== heroId && isTiledCanvasNode(n));
      if (next) {
        // Straight to enterFocus, not promoteFocus: the hero id still held by the ref is the one that
        // just died, so there is no toggle to guard against.
        enterFocus(next.id);
        return;
      }
      // Nothing left to focus. Now exiting is the only honest answer.
      exitFocus();
      return;
    }
    const area = measureArea();
    const fit = area ? { width: area.width, height: area.height } : FALLBACK_FIT;
    holdCanvasArrangeGlide(morphDuration());
    // Re-asserted on a re-tile too: a create or close can leave the selection on a cell that is no
    // longer the hero, and every selection-keyed gesture would then act on the wrong one.
    onHeroChange?.(heroId);
    frameCamera(applyFocusLayout(heroId, fit), area);
  }, [applyFocusLayout, captureNewNodes, enterFocus, exitFocus, frameCamera, measureArea, onHeroChange]);

  /**
   * Leave focus mode without moving anything and return the hero plus canonical pre-focus snapshot.
   *
   * For the project switch. `exitFocus` restores through `setNodes` and animates the camera; the
   * outgoing board is about to be replaced by another project's, so the glide would run over the
   * wrong nodes and the restored positions would land one render too late for the save that needs
   * them. The caller applies the snapshot synchronously (`settleLayoutSnapshot`) and saves that.
   * `null` when nothing was focused. `onLeaveFocus` still runs so the rail and the veil are cleared.
   */
  const inspectFocus = useCallback((): CanvasFocusSession | null => {
    const heroId = focusedRef.current;
    if (!heroId) return null;
    return { heroId, snapshot: new Map(snapshotRef.current ?? []) };
  }, []);

  const settleFocus = useCallback((): CanvasFocusSession | null => {
    const heroId = focusedRef.current;
    if (!heroId) return null;
    setFocusedNodeId(null);
    focusedRef.current = null;
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    onLeaveFocus?.();
    return { heroId, snapshot: snapshot ?? new Map() };
  }, [onLeaveFocus]);

  // Esc exits focus — but never while the user is typing in an input/editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !focusedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      exitFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitFocus]);

  return { focusedNodeId, enterFocus, promoteFocus, exitFocus, refreshFocus, inspectFocus, settleFocus };
}
