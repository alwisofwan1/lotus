"use client";

import { useEffect, useRef } from "react";
import type { Node } from "@xyflow/react";
import type { CanvasFocusSession } from "../hooks/useCanvasFocusMode";
import type { ArrangeBox } from "../services/canvas-arrange";
import { isTiledCanvasNode } from "../services/canvas-arrange";
import { canonicalCanvasNodes } from "../services/canvas-canonical-layout";
import { canvasProjectViewStateStore } from "../services/canvas-project-view-state";

interface UseCanvasProjectFocusViewOptions {
  activeProjectId: string | null;
  loading: boolean;
  ready: boolean;
  nodes: Node[];
  setBeforeBoardSwap: (handler: (() => Node[] | null) | null) => void;
  setPrepareNodesForSave: (handler: ((nodes: Node[]) => Node[]) | null) => void;
  inspectFocus: () => CanvasFocusSession | null;
  settleFocus: () => CanvasFocusSession | null;
  settleLayoutSnapshot: (snapshot: Map<string, ArrangeBox> | null) => Node[];
  restoreFocus: (heroNodeId: string) => void;
}

/** Remembers each project's focus hero across a board swap, and restores it once the board is ready. */
export function useCanvasProjectFocusView({
  activeProjectId,
  loading,
  ready,
  nodes,
  setBeforeBoardSwap,
  setPrepareNodesForSave,
  inspectFocus,
  settleFocus,
  settleLayoutSnapshot,
  restoreFocus,
}: UseCanvasProjectFocusViewOptions): void {
  const restoredProjectRef = useRef<string | null>(null);

  useEffect(() => {
    setPrepareNodesForSave((liveNodes) => canonicalCanvasNodes(liveNodes, inspectFocus()?.snapshot ?? null));
    return () => setPrepareNodesForSave(null);
  }, [inspectFocus, setPrepareNodesForSave]);

  useEffect(() => {
    setBeforeBoardSwap(() => {
      const session = settleFocus();
      if (activeProjectId) {
        if (session) canvasProjectViewStateStore.rememberFocus(activeProjectId, session.heroId);
        else canvasProjectViewStateStore.rememberBoard(activeProjectId);
      }
      restoredProjectRef.current = null;
      return session ? settleLayoutSnapshot(session.snapshot) : null;
    });
    return () => setBeforeBoardSwap(null);
  }, [activeProjectId, setBeforeBoardSwap, settleFocus, settleLayoutSnapshot]);

  useEffect(() => {
    if (loading || !ready || !activeProjectId || restoredProjectRef.current === activeProjectId) return;
    restoredProjectRef.current = activeProjectId;
    const state = canvasProjectViewStateStore.read(activeProjectId);
    const hero = state.mode !== "board"
      ? nodes.find((node) => node.id === state.heroNodeId && isTiledCanvasNode(node))
      : null;
    if (!hero) {
      if (state.mode !== "board") canvasProjectViewStateStore.rememberBoard(activeProjectId);
      return;
    }
    // A project saved in the old "fleet" mode reopens in plain focus mode on the same hero: Fleet
    // lives in the Canvas Dock now (plans/canvas-dock/), and the fleet rail is gone.
    restoreFocus(hero.id);
  }, [activeProjectId, loading, nodes, ready, restoreFocus]);
}
