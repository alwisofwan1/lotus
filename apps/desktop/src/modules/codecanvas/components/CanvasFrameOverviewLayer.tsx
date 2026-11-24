"use client";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useReactFlow, type Node } from "@xyflow/react";
import { frameAtPoint, overviewDimmedNodeIds } from "../services/canvas-frame-overview";
import { frameColorCss } from "../services/canvas-frame-palette";
import { frameTitleOf, isFrameNode } from "../services/canvas-frames";
import { useFrameOverviewFocusedId } from "../services/canvas-frame-overview-store";
import { useCanvasOcclusionLock } from "../hooks/useCanvasOcclusionLock";

interface Props {
  nodes: Node[];
  onFocus: (frameId: string | null) => void;
  onFlyIn: (frameId: string) => void;
  /** A Frame was dropped on another Frame's slot (decision 43). */
  onSwap: (frameId: string, ontoFrameId: string) => void;
  onExit: () => void;
}

/** Pointer travel before a press becomes a drag, screen px. */
const DRAG_THRESHOLD = 6;

const cssString = (id: string) => id.replace(/["\\]/g, "\\$&");

interface DragState {
  frameId: string;
  startX: number;
  startY: number;
  moved: boolean;
}

/**
 * The Frame Overview's interaction layer, rendered inside ReactFlow while the overview is open.
 * Normal node interaction is DISABLED on purpose: this full-size layer sits above the nodes and owns
 * the pointer, so a click can only mean "fly into the Frame under it" and nothing is dragged or
 * edited by accident at 40% zoom. Hover maps the screen point to flow space and lights that Frame
 * (FrameNode reads the overview store) while every other node dims quietly (decision 44). Pressing
 * a Frame and dragging onto another swaps the two (decision 43): the layer draws a small ghost under
 * the pointer and the drop target lights up; the nodes themselves only move once, on drop, through the
 * grid's own animation. Styles live in styles/canvas/canvas-frame-node.css. The layer covers the whole
 * canvas, so it holds an occlusion lock: Canvas Browser Nodes park their native WebView instead of
 * painting over it.
 */
export const CanvasFrameOverviewLayer = memo(function CanvasFrameOverviewLayer({ nodes, onFocus, onFlyIn, onSwap, onExit }: Props) {
  useCanvasOcclusionLock(true, "frame-overview");
  const flow = useReactFlow();
  const frameCount = nodes.filter(isFrameNode).length;
  const litId = useFrameOverviewFocusedId();
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [ghost, setGhost] = useState<{ frameId: string; x: number; y: number } | null>(null);

  const frameUnder = useCallback(
    (clientX: number, clientY: number) => frameAtPoint(nodes, flow.screenToFlowPosition({ x: clientX, y: clientY })),
    [flow, nodes],
  );

  const dimCss = useMemo(() => {
    const ids = overviewDimmedNodeIds(nodes, litId);
    if (ids.length === 0) return null;
    return `${ids.map((id) => `.react-flow__node[data-id="${cssString(id)}"] > *`).join(",")}{opacity:0.55}`;
  }, [nodes, litId]);

  const ghostFrame = ghost ? nodes.find((n) => n.id === ghost.frameId) : undefined;

  return (
    <>
      {dimCss ? <style data-testid="frame-overview-dim">{dimCss}</style> : null}
      <div
        className="canvas-frame-overview-layer"
        data-testid="frame-overview-layer"
        data-dragging={ghost ? "true" : undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const id = frameUnder(e.clientX, e.clientY);
          dragRef.current = id ? { frameId: id, startX: e.clientX, startY: e.clientY, moved: false } : null;
          if (id) e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const id = frameUnder(e.clientX, e.clientY);
          if (id) onFocus(id);
          const drag = dragRef.current;
          if (!drag) return;
          if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
          drag.moved = true;
          const rect = e.currentTarget.getBoundingClientRect();
          setGhost({ frameId: drag.frameId, x: e.clientX - rect.left, y: e.clientY - rect.top });
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          dragRef.current = null;
          setGhost(null);
          if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          if (!drag?.moved) return;
          suppressClickRef.current = true;
          const target = frameUnder(e.clientX, e.clientY);
          if (target && target !== drag.frameId) onSwap(drag.frameId, target);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setGhost(null);
        }}
        onClick={(e) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          const id = frameUnder(e.clientX, e.clientY);
          if (id) onFlyIn(id);
          else if (frameCount === 0) onExit();
        }}
      >
        {ghost && ghostFrame ? (
          <div
            className="canvas-frame-overview-ghost"
            data-testid="frame-overview-ghost"
            style={{ left: ghost.x, top: ghost.y, "--frame-color": frameColorCss((ghostFrame.data as { colorId?: string }).colorId) } as React.CSSProperties}
          >
            <i aria-hidden="true" />
            {frameTitleOf(ghostFrame) || "Frame"}
          </div>
        ) : null}
      </div>
    </>
  );
});
