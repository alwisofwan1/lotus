"use client";
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { frameBoxFromDrag } from "../services/canvas-frame-geometry";

/** Below this (flow units) a press is a click, not a drag: no Frame is drawn. */
const MIN_DRAG_PX = 24;

interface Props {
  flowInstance: ReactFlowInstance<Node, Edge>;
  onCreate: (box: { x: number; y: number; w: number; h: number }) => void;
  onCancel: () => void;
}

/**
 * Full-canvas gesture layer while the Frame tool is armed (press N, then drag; Esc cancels).
 * Shift draws a square, Alt grows from the centre. The preview runs at pointer rate, so it is
 * written to the DOM directly rather than through React state, like CanvasDrawCapture.
 */
export function CanvasFrameDrawCapture({ flowInstance, onCreate, onCancel }: Props) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);

  const paint = useCallback((box: { x: number; y: number; w: number; h: number } | null, zoom = 1) => {
    const el = previewRef.current;
    const label = sizeRef.current;
    if (!el || !label) return;
    if (!box) {
      el.style.display = "none";
      label.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    label.style.display = "block";
    label.style.left = `${box.x + box.w / 2}px`;
    label.style.top = `${box.y + box.h + 8}px`;
    label.style.transform = "translateX(-50%)";
    label.textContent = `${Math.round(box.w / zoom)} × ${Math.round(box.h / zoom)}`;
  }, []);

  const screenBox = (start: { x: number; y: number }, event: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean }) =>
    frameBoxFromDrag(start, { x: event.clientX, y: event.clientY }, { square: event.shiftKey, fromCentre: event.altKey });

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startRef.current = { x: event.clientX, y: event.clientY };
    paint({ x: event.clientX, y: event.clientY, w: 0, h: 0 });
  }, [paint]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    paint(screenBox(start, event), flowInstance.getZoom());
  }, [flowInstance, paint]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    startRef.current = null;
    paint(null);
    if (!start) return;
    const box = screenBox(start, event);
    if (box.w < MIN_DRAG_PX || box.h < MIN_DRAG_PX) {
      onCancel();
      return;
    }
    const topLeft = flowInstance.screenToFlowPosition({ x: box.x, y: box.y });
    const bottomRight = flowInstance.screenToFlowPosition({ x: box.x + box.w, y: box.y + box.h });
    onCreate({ x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y });
  }, [flowInstance, onCancel, onCreate, paint]);

  return (
    <div
      className="canvas-draw-capture"
      data-shape="frame"
      data-testid="frame-draw-capture"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div ref={previewRef} className="canvas-draw-preview" data-shape="frame" style={{ position: "fixed", display: "none" }} />
      <div ref={sizeRef} className="canvas-frame-draw-size" style={{ display: "none" }} />
    </div>
  );
}
