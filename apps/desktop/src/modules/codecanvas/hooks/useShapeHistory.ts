"use client";
import { useCallback, useEffect, useRef } from "react";
import type { Edge, Node } from "@xyflow/react";
import { isRedoAliasChord } from "@/lib/hotkeys/platform-chords";
import {
  captureShapeSnapshot,
  createShapeHistory,
  shapeSnapshotsEqual,
  type ShapeHistory,
  type ShapeSnapshot,
} from "../services/canvas-shape-history";
import { isLayoutBoard } from "../services/canvas-board-marks";

/** Idle window that coalesces a gesture (drag frames, keystroke auto-size) into ONE undo step. */
export const SHAPE_HISTORY_COMMIT_MS = 300;

interface UseShapeHistoryArgs {
  /** The live board — the hook observes shape (and shape-connector) changes across renders. */
  nodes: Node[];
  edges: Edge[];
  /** History is per project: a key change (project switch/load) resets the stack. */
  resetKey: string | null;
  /** Applies a restored snapshot to the board (useCanvasNodes.restoreShapeSnapshot). */
  restore: (snapshot: ShapeSnapshot) => void;
}

/**
 * Whiteboard undo/redo (⌘Z / ⇧⌘Z). Observes the shape subset of the board — shapes plus the
 * connectors between them — and records an entry once mutations go idle for
 * SHAPE_HISTORY_COMMIT_MS, so a drag or a burst of typing is one step, not thirty. Restores go
 * through `restore` and are never re-recorded (the baseline is advanced to the restored state
 * first, then rebaselined onto the board's actual post-restore objects). Non-shape churn
 * (terminals, agents, their wires) never records: those lifecycles carry runtime side effects
 * undo must not replay.
 */
export function useShapeHistory({ nodes, edges, resetKey, restore }: UseShapeHistoryArgs): {
  undo: () => void;
  redo: () => void;
  /** Forget everything: for an action that cannot be undone (it ended runtime sessions). */
  clear: () => void;
} {
  const committedRef = useRef<ShapeSnapshot>(captureShapeSnapshot(nodes, edges));
  const latestRef = useRef<ShapeSnapshot>(committedRef.current);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<ShapeHistory | null>(null);
  historyRef.current ??= createShapeHistory();
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  const cancelPending = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // Commit whatever is pending NOW (an undo mid-gesture must undo the gesture, not skip it).
  const flush = useCallback(() => {
    cancelPending();
    if (!shapeSnapshotsEqual(committedRef.current, latestRef.current)) {
      historyRef.current!.record(committedRef.current, latestRef.current);
      committedRef.current = latestRef.current;
    }
  }, [cancelPending]);

  // Project switch/load: this board's history must not leak into the next one.
  const resetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (resetKeyRef.current === resetKey) return;
    resetKeyRef.current = resetKey;
    cancelPending();
    historyRef.current = createShapeHistory();
    committedRef.current = captureShapeSnapshot(nodes, edges);
    latestRef.current = committedRef.current;
  }, [resetKey, nodes, edges, cancelPending]);

  // Observe shape/connector changes; schedule an idle-coalesced commit.
  const restoringRef = useRef(false);
  useEffect(() => {
    const snapshot = captureShapeSnapshot(nodes, edges);
    if (restoringRef.current) {
      // First render after our own restore: adopt the board's ACTUAL objects/indices as the
      // baseline. restoreShapes rewrites selected shapes as new (deselected) objects, so the
      // snapshot's identities drift — recording that drift would wipe the redo branch.
      restoringRef.current = false;
      committedRef.current = snapshot;
      latestRef.current = snapshot;
      return;
    }
    if (isLayoutBoard(nodes)) {
      // Arrange, re-tile, node focus, Grid snap: automatic, never a step. A user change still pending lands as
      // its own step first, then the laid-out board becomes the baseline.
      flush();
      committedRef.current = snapshot;
      latestRef.current = snapshot;
      return;
    }
    if (shapeSnapshotsEqual(snapshot, latestRef.current)) return;
    latestRef.current = snapshot;
    cancelPending();
    if (shapeSnapshotsEqual(snapshot, committedRef.current)) return; // settled back to baseline
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      historyRef.current!.record(committedRef.current, latestRef.current);
      committedRef.current = latestRef.current;
    }, SHAPE_HISTORY_COMMIT_MS);
  }, [nodes, edges, cancelPending, flush]);
  useEffect(() => cancelPending, [cancelPending]);

  const step = useCallback((direction: "undo" | "redo") => {
    flush();
    const snapshot = direction === "undo" ? historyRef.current!.undo() : historyRef.current!.redo();
    if (!snapshot) return;
    // Advance the baseline BEFORE the board re-renders so the restore is never re-recorded; the
    // observe effect then rebaselines onto the board's actual post-restore objects (see above).
    committedRef.current = snapshot;
    latestRef.current = snapshot;
    restoringRef.current = true;
    restoreRef.current(snapshot);
  }, [flush]);

  const undo = useCallback(() => step("undo"), [step]);
  const redo = useCallback(() => step("redo"), [step]);

  // ⌘Z / ⇧⌘Z (Ctrl on non-mac, plus the Windows redo Ctrl+Y). Anything editable owns its own
  // undo — never intercept there.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const redoAlias = isRedoAliasChord(event);
      if (!redoAlias && (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey) || event.altKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      if (redoAlias || event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // The next render adopts the board as it then is as the new baseline (same path as a restore),
  // so the destructive change itself never becomes an undo step either.
  const clear = useCallback(() => {
    cancelPending();
    historyRef.current = createShapeHistory();
    restoringRef.current = true;
  }, [cancelPending]);

  return { undo, redo, clear };
}
