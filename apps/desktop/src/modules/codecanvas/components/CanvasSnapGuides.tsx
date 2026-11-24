"use client";
import { ViewportPortal } from "@xyflow/react";
import { useCanvasSnapGuides } from "../services/canvas-snap-store";

/**
 * Alignment guide lines and equal-spacing gap segments while a shape drag is snapped
 * (canvas-snapping.ts). Rendered in flow coordinates via ViewportPortal so they track pan/zoom
 * for free; only this component re-renders as guides change — the board itself never does.
 */
export function CanvasSnapGuides() {
  const { lines, gaps } = useCanvasSnapGuides();
  if (lines.length === 0 && gaps.length === 0) return null;
  return (
    <ViewportPortal>
      {lines.map((g, i) => (
        <div
          key={`l${i}`}
          className="canvas-snap-guide"
          data-orientation={g.orientation}
          style={
            g.orientation === "v"
              ? { position: "absolute", left: g.at, top: g.from, width: 1, height: g.to - g.from }
              : { position: "absolute", left: g.from, top: g.at, width: g.to - g.from, height: 1 }
          }
        />
      ))}
      {gaps.map((g, i) => (
        <div
          key={`g${i}`}
          className="canvas-gap-guide"
          data-orientation={g.orientation}
          style={
            g.orientation === "h"
              ? { position: "absolute", left: g.start, top: g.cross, width: g.end - g.start, height: 0 }
              : { position: "absolute", left: g.cross, top: g.start, width: 0, height: g.end - g.start }
          }
        />
      ))}
    </ViewportPortal>
  );
}
