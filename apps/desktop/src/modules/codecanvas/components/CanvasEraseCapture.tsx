"use client";
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { shapeHitTest, type HitTestNode } from "../services/canvas-erase";

interface CanvasEraseCaptureProps {
  /** Whiteboard shape nodes eligible for erasing (workflow nodes are excluded by the caller). */
  nodes: HitTestNode[];
  flowInstance: ReactFlowInstance<Node, Edge>;
  onErase: (id: string) => void;
}

/**
 * Full-canvas gesture layer shown only while the eraser tool is active. Excalidraw's
 * mark-then-commit model: shapes passed over during the stroke are only MARKED (dimmed via
 * `canvas-erase-marked` on their ReactFlow wrappers), and deleted together on release —
 * so a slipped stroke is recoverable with Escape instead of destroying shapes mid-drag.
 * The dimming is direct DOM classwork on purpose: it runs at pointer rate and must not
 * re-render the board per move. Owns the gesture so ReactFlow never pans/selects mid-erase.
 */
export function CanvasEraseCapture({ nodes, flowInstance, onErase }: CanvasEraseCaptureProps) {
  const erasingRef = useRef(false);
  const markedRef = useRef<Set<string>>(new Set());

  const setMarkClass = (id: string, marked: boolean) => {
    document.querySelector(`.react-flow__node[data-id="${id}"]`)?.classList.toggle("canvas-erase-marked", marked);
  };

  const clearMarks = useCallback(() => {
    markedRef.current.forEach((id) => setMarkClass(id, false));
    markedRef.current = new Set();
  }, []);

  const markAt = useCallback((clientX: number, clientY: number) => {
    const point = flowInstance.screenToFlowPosition({ x: clientX, y: clientY });
    for (const id of shapeHitTest(nodes, point)) {
      if (!markedRef.current.has(id)) {
        markedRef.current.add(id);
        setMarkClass(id, true);
      }
    }
  }, [nodes, flowInstance]);

  const handleDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    erasingRef.current = true;
    markedRef.current = new Set();
    markAt(event.clientX, event.clientY);
  }, [markAt]);

  const handleMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (erasingRef.current) markAt(event.clientX, event.clientY);
  }, [markAt]);

  const handleUp = useCallback(() => {
    if (!erasingRef.current) return;
    erasingRef.current = false;
    const marked = [...markedRef.current];
    clearMarks();
    marked.forEach(onErase);
  }, [clearMarks, onErase]);

  // Escape aborts the stroke: everything un-dims, nothing is deleted.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !erasingRef.current) return;
      erasingRef.current = false;
      clearMarks();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearMarks]);
  // Unmount mid-stroke (tool switch) must not leave dimmed wrappers behind.
  useEffect(() => clearMarks, [clearMarks]);

  return (
    <div
      className="canvas-erase-capture"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
    />
  );
}
