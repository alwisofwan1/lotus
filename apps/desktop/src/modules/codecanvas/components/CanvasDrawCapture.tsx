"use client";
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import type { CanvasShapeKind } from "../types/canvas";
import { linearShapeFromDrag, normalizeFreehand, shapeRectFromDrag } from "../services/canvas-shape";
import { simplifyTrail, type TrailPoint } from "../services/canvas-freehand";
import { DEFAULT_SHAPE_SIZE, DEFAULT_TEXT_SIZE } from "../services/canvas-node-placement";

/** Screen-px tolerance for trail simplification at commit — noise collapses, curvature stays. */
const TRAIL_EPSILON_PX = 1.25;

interface CanvasDrawCaptureProps {
  /** The shape kind to create (the active shape tool). */
  shape: CanvasShapeKind;
  flowInstance: ReactFlowInstance<Node, Edge>;
  onCreate: (
    shape: CanvasShapeKind,
    position: { x: number; y: number },
    size: { w: number; h: number },
    points?: Array<[number, number]>,
  ) => void;
}

/**
 * Full-canvas gesture layer shown only while a shape tool is active. Press-drag draws a
 * sized shape (Excalidraw-style); a click places a default-sized one. It owns the gesture
 * so ReactFlow never pans/selects mid-draw.
 *
 * The live feedback runs at pointer rate, so it deliberately bypasses React: the trail
 * polyline and the box preview are always-mounted elements updated in place (attribute /
 * style writes), and the freehand trail additionally reads `getCoalescedEvents()` — a 120Hz+
 * pointer batches several samples into one event, and dropping them visibly flattens fast
 * curves. The raw trail is simplified (RDP) once, at commit.
 */
export function CanvasDrawCapture({ shape, flowInstance, onCreate }: CanvasDrawCaptureProps) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const trailStrRef = useRef("");
  const polyRef = useRef<SVGPolylineElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const isFreehand = shape === "draw";
  const showsBoxPreview = !isFreehand && shape !== "text";

  const appendTrailPoint = useCallback((x: number, y: number) => {
    trailRef.current.push({ x, y });
    trailStrRef.current = trailStrRef.current ? `${trailStrRef.current} ${x},${y}` : `${x},${y}`;
  }, []);

  const paintTrail = useCallback(() => {
    polyRef.current?.setAttribute("points", trailStrRef.current);
  }, []);

  const paintPreview = useCallback((box: { x: number; y: number; w: number; h: number } | null) => {
    const el = previewRef.current;
    if (!el) return;
    if (!box) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startRef.current = { x: event.clientX, y: event.clientY };
    trailRef.current = [];
    trailStrRef.current = "";
    appendTrailPoint(event.clientX, event.clientY);
    paintTrail();
    paintPreview(showsBoxPreview ? { x: event.clientX, y: event.clientY, w: 0, h: 0 } : null);
  }, [appendTrailPoint, paintTrail, paintPreview, showsBoxPreview]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    if (isFreehand) {
      // A fast stroke arrives as one event carrying several coalesced samples — keep them all.
      const native = event.nativeEvent;
      const samples: Array<{ clientX: number; clientY: number }> =
        native.getCoalescedEvents?.() ?? [native];
      for (const s of samples.length > 0 ? samples : [native]) appendTrailPoint(s.clientX, s.clientY);
      paintTrail();
      return;
    }
    if (showsBoxPreview) {
      paintPreview({
        x: Math.min(start.x, event.clientX),
        y: Math.min(start.y, event.clientY),
        w: Math.abs(event.clientX - start.x),
        h: Math.abs(event.clientY - start.y),
      });
    }
  }, [isFreehand, appendTrailPoint, paintTrail, paintPreview, showsBoxPreview]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    const drawnTrail = trailRef.current;
    startRef.current = null;
    trailRef.current = [];
    trailStrRef.current = "";
    paintTrail();
    paintPreview(null);
    if (!start) return;
    if (isFreehand) {
      // Simplify in screen space (perception is screen-relative), then map into flow space.
      const simplified = simplifyTrail([...drawnTrail, { x: event.clientX, y: event.clientY }], TRAIL_EPSILON_PX);
      const flowTrail = simplified.map((p) => flowInstance.screenToFlowPosition(p));
      const { position, size, points } = normalizeFreehand(flowTrail);
      onCreate(shape, position, size, points);
      return;
    }
    const from = flowInstance.screenToFlowPosition({ x: start.x, y: start.y });
    const to = flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (shape === "arrow" || shape === "line") {
      const linear = linearShapeFromDrag(from, to);
      onCreate(shape, linear.position, linear.size, linear.points);
    } else if (shape === "text") {
      // Text is placed at the click point with a caret-sized box; it auto-sizes once typed.
      onCreate(shape, from, { ...DEFAULT_TEXT_SIZE });
    } else {
      const { position, size } = shapeRectFromDrag(from, to, DEFAULT_SHAPE_SIZE);
      onCreate(shape, position, size, undefined);
    }
  }, [flowInstance, onCreate, shape, isFreehand, paintTrail, paintPreview]);

  return (
    <div
      className="canvas-draw-capture"
      data-shape={shape}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {isFreehand ? (
        <svg className="canvas-draw-trail" style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} aria-hidden="true">
          <polyline
            ref={polyRef}
            points=""
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : showsBoxPreview ? (
        <div
          ref={previewRef}
          className="canvas-draw-preview"
          data-shape={shape}
          style={{ position: "fixed", display: "none" }}
        />
      ) : null}
    </div>
  );
}
