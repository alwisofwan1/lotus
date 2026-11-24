"use client";
import { memo, useState } from "react";
import type { ReactNode } from "react";
import { Handle, Position, NodeResizer } from "@xyflow/react";
import type { CanvasLodTier } from "../../services/canvas-lod";
import type { DrawSloppiness } from "../../services/canvas-rough";
import { RoughNodeBorder } from "./RoughNodeBorder";

type CanvasHandleSide = "top" | "right" | "bottom" | "left";

interface CanvasFrameHandle {
  side: CanvasHandleSide;
  position: Position;
  label: string;
}

/**
 * Node kinds that get the spawn sheen — the two live glass families from the Canvas Terminal
 * revamp. It is the idiom for a panel that boots into a running process, not generic chrome, so
 * notes/tasks/plans deliberately stay still.
 */
const SHEEN_KINDS = new Set<CanvasNodeFrameProps["kind"]>(["terminal", "agent"]);

const CANVAS_FRAME_HANDLES: CanvasFrameHandle[] = [
  { side: "top", position: Position.Top, label: "Wire from top side" },
  { side: "right", position: Position.Right, label: "Wire from right side" },
  { side: "bottom", position: Position.Bottom, label: "Wire from bottom side" },
  { side: "left", position: Position.Left, label: "Wire from left side" },
];

export interface CanvasNodeFrameProps {
  kind: "terminal" | "note" | "skill" | "skills" | "agent" | "team" | "plan" | "run" | "task" | "context" | "critic" | "human-gate" | "browser" | "music" | "host-cell" | "factory" | "file";
  selected: boolean;
  minWidth: number;
  minHeight: number;
  header: ReactNode;
  children: ReactNode;
  /** Floating siblings (e.g. Canvas Worktree/Skill Panel) that overflow the body. */
  overlay?: ReactNode;
  /** Current level-of-detail tier (defaults to full detail). */
  lodTier?: CanvasLodTier;
  /** Zoomed-out stand-in (a solid status block) rendered in place of the body at collapsed LOD tiers. */
  glyph?: ReactNode;
  /** Drives the per-status accent strip (e.g. terminal idle/running). */
  statusTone?: string;
  /** Emits resize gesture state for native overlays that need to park during geometry changes. */
  onResizeChange?: (resizing: boolean) => void;
  /** Opt-in Excalidraw-style hand-drawn (rough.js) border. Visual only. */
  rough?: boolean;
  /** Measured node size (from NodeProps) — required for the rough border to render. */
  width?: number;
  height?: number;
  /** Stable per-node seed (roughSeedFromId) so the wobble never re-randomizes. */
  roughSeed?: number;
  roughSloppiness?: DrawSloppiness;
  roughStroke?: string;
  /** Armed as the drop target for a file/image drag — shows the inset accent frame + label. */
  dropActive?: boolean;
  /** Label shown in the drop frame's pill (e.g. "Drop to attach to Ren"). */
  dropLabel?: string;
}

/** Shared chrome for every Canvas Node — resize control, connection handles, and slots. */
export const CanvasNodeFrame = memo(function CanvasNodeFrame({
  kind,
  selected,
  minWidth,
  minHeight,
  header,
  children,
  overlay,
  lodTier = "full",
  glyph,
  statusTone,
  onResizeChange,
  rough,
  width,
  height,
  roughSeed,
  roughSloppiness,
  roughStroke,
  dropActive,
  dropLabel,
}: CanvasNodeFrameProps) {
  const collapsed = lodTier !== "full" && glyph != null;
  const [resizing, setResizing] = useState(false);
  const showRough = Boolean(rough) && !collapsed;

  return (
    <div
      className={`canvas-node canvas-${kind}-node${selected ? " selected" : ""}${collapsed ? " canvas-node--glyph" : ""}${lodTier === "overview" ? " canvas-node--overview" : ""}${resizing ? " canvas-node--resizing" : ""}${dropActive ? " canvas-node--drop-target" : ""}`}
      data-lod={lodTier}
      data-node-status={statusTone}
      data-resizing={resizing || undefined}
      data-rough={showRough ? "true" : undefined}
      data-drop-target={dropActive || undefined}
    >
      <NodeResizer
        minWidth={minWidth}
        minHeight={minHeight}
        isVisible={!collapsed}
        handleClassName="canvas-node-resize-handle"
        lineClassName="canvas-node-resize-line"
        onResizeStart={() => {
          setResizing(true);
          onResizeChange?.(true);
        }}
        onResizeEnd={() => {
          setResizing(false);
          onResizeChange?.(false);
        }}
      />
      {CANVAS_FRAME_HANDLES.map((handle) => (
        <Handle
          key={handle.side}
          id={`wire-${handle.side}`}
          type="source"
          position={handle.position}
          aria-label={handle.label}
          title={handle.label}
          className={`canvas-node-handle canvas-node-handle--wire canvas-node-handle--${handle.side}`}
          data-canvas-handle-side={handle.side}
        />
      ))}
      {/* Mounted OUTSIDE the collapsed/full swap below, on purpose: its CSS animation is a
          one-shot that plays when the element mounts, so it must mount exactly once per node.
          Rendered inside the swap it would remount on every LOD crossing and flash a
          "just spawned" sweep across terminals that have been running for minutes. */}
      {SHEEN_KINDS.has(kind) ? <span className="canvas-node-sheen" aria-hidden="true" /> : null}
      {showRough ? (
        <RoughNodeBorder
          width={width}
          height={height}
          seed={roughSeed ?? 0}
          sloppiness={roughSloppiness}
          strokeColor={roughStroke ?? "rgba(232, 225, 236, 0.92)"}
        />
      ) : null}
      {collapsed ? (
        glyph
      ) : (
        <>
          {header}
          {children}
          {overlay}
        </>
      )}
      {dropActive ? (
        <div className="canvas-node-drop-frame" aria-hidden>
          <div className="canvas-node-drop-veil" />
          <div className="canvas-node-drop-ring" />
          {dropLabel ? (
            <div className="canvas-node-drop-pill">
              <span className="canvas-node-drop-clip">↓</span>
              {dropLabel}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
