"use client";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Pt } from "../../services/canvas-linear";

interface ShapePointHandlesProps {
  /** Normalized 0..1 points within the node box. */
  points: Pt[];
  /** Drag a point (by index) to a screen position — the parent refits the node box in flow space. */
  onPointDrag: (index: number, clientX: number, clientY: number) => void;
  /** Persist after a drag gesture ends. */
  onPointCommit: () => void;
  /** Insert a new point into segment `segIndex` at the screen position; returns its new index.
   *  When provided, mid-segment "bend" handles are shown (arrow/line only, not freehand). */
  onMidpointInsert?: (segIndex: number, clientX: number, clientY: number) => number;
}

/**
 * Draggable point handles for a selected linear shape (Excalidraw-style). Endpoint drags
 * lengthen/shorten the arrow (the parent grows the node box); mid-segment handles insert a
 * bend point and drag it. Drag is tracked via window listeners so it survives the re-renders
 * caused by live box resizing. The layer is click-through; only handles capture the pointer.
 */
export function ShapePointHandles({ points, onPointDrag, onPointCommit, onMidpointInsert }: ShapePointHandlesProps) {
  const dragRef = useRef<number | null>(null);
  const dragCb = useRef(onPointDrag);
  const commitCb = useRef(onPointCommit);
  // Keep the latest callbacks without re-attaching the window listeners (updated post-render).
  useEffect(() => {
    dragCb.current = onPointDrag;
    commitCb.current = onPointCommit;
  });

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (dragRef.current !== null) dragCb.current(dragRef.current, e.clientX, e.clientY);
    };
    const up = () => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      commitCb.current();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  const midpoints = onMidpointInsert
    ? points.slice(0, -1).map((p, i) => [i, (p[0] + points[i + 1][0]) / 2, (p[1] + points[i + 1][1]) / 2] as const)
    : [];

  return (
    <div className="canvas-point-layer nodrag nopan nowheel" aria-hidden="true">
      {midpoints.map(([seg, mx, my]) => (
        <div
          key={`mid-${seg}`}
          className="canvas-point-midhandle"
          style={{ left: `${mx * 100}%`, top: `${my * 100}%` }}
          onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
            e.stopPropagation();
            dragRef.current = onMidpointInsert!(seg, e.clientX, e.clientY);
          }}
        />
      ))}
      {points.map((p, i) => (
        <div
          key={i}
          className="canvas-point-handle"
          style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }}
          onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
            e.stopPropagation();
            dragRef.current = i;
          }}
        />
      ))}
    </div>
  );
}
