"use client";

import { useMemo } from "react";
import type { CanvasEdgeRecord, CanvasNodeRecord } from "../types/canvas";

const VIEW_W = 100;
const VIEW_H = 178; // ~9:16 viewbox
const PAD = 10;

interface Props {
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
  accent: string;
}

/**
 * Tiny SVG miniature of a canvas's node graph. Node positions are normalized
 * into the card viewbox (bounding box → padded fit). Nodes draw as small
 * rounded-rects, edges as thin lines between node centers. Monochrome-ish:
 * the seeded accent for nodes, muted white for edges.
 */
export function CanvasMiniMap({ nodes, edges, accent }: Props) {
  const layout = useMemo(() => {
    if (nodes.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const w = n.size?.w ?? 160;
      const h = n.size?.h ?? 90;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const innerW = VIEW_W - PAD * 2;
    const innerH = VIEW_H - PAD * 2;
    // Uniform scale to preserve aspect; center within the inner area.
    const scale = Math.min(innerW / spanX, innerH / spanY);
    const drawW = spanX * scale;
    const drawH = spanY * scale;
    const offX = PAD + (innerW - drawW) / 2;
    const offY = PAD + (innerH - drawH) / 2;

    const project = (x: number, y: number) => ({
      x: offX + (x - minX) * scale,
      y: offY + (y - minY) * scale,
    });

    const placed = new Map<string, { cx: number; cy: number; w: number; h: number }>();
    const rects = nodes.map((n) => {
      const w = n.size?.w ?? 160;
      const h = n.size?.h ?? 90;
      const p = project(n.position.x, n.position.y);
      const rw = Math.max(3, w * scale);
      const rh = Math.max(2.4, h * scale);
      placed.set(n.id, { cx: p.x + rw / 2, cy: p.y + rh / 2, w: rw, h: rh });
      return { id: n.id, x: p.x, y: p.y, w: rw, h: rh };
    });

    const lines = edges
      .map((e) => {
        const s = placed.get(e.source);
        const t = placed.get(e.target);
        if (!s || !t) return null;
        return { id: e.id, x1: s.cx, y1: s.cy, x2: t.cx, y2: t.cy };
      })
      .filter((l): l is { id: string; x1: number; y1: number; x2: number; y2: number } => l !== null);

    return { rects, lines };
  }, [nodes, edges]);

  if (!layout) {
    // Empty canvas — faint dot pattern hint.
    return (
      <svg className="canvas-gallery-mini" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
        {[0.32, 0.5, 0.68].map((fx) =>
          [0.34, 0.5, 0.66].map((fy) => (
            <circle key={`${fx}-${fy}`} cx={VIEW_W * fx} cy={VIEW_H * fy} r={1.4} fill="rgba(247,242,234,0.16)" />
          )),
        )}
      </svg>
    );
  }

  return (
    <svg className="canvas-gallery-mini" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <g stroke="rgba(247,242,234,0.22)" strokeWidth={0.6}>
        {layout.lines.map((l) => (
          <line key={l.id} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
        ))}
      </g>
      <g>
        {layout.rects.map((r) => (
          <rect
            key={r.id}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            rx={1.6}
            fill={accent}
            fillOpacity={0.82}
          />
        ))}
      </g>
    </svg>
  );
}
