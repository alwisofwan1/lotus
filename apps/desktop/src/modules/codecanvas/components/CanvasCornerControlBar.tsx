"use client";
import { memo, useRef } from "react";
import { Brain, MessagesSquare } from "lucide-react";
import { CanvasZoomControlView } from "./CanvasZoomControl";
import { usePublishedElementWidth } from "../hooks/usePublishedElementWidth";
import type { CanvasViewportZoomBounds } from "../services/canvas-viewport-store";
import { useCornerControlsWake } from "../hooks/useCornerControlsWake";

export interface CanvasCornerControlBarProps {
  zoom: number;
  bounds: CanvasViewportZoomBounds;
  onFitAll: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  memoryOpen: boolean;
  memoryCount: number;
  onToggleMemory: () => void;
  /** Hide the memory affordance entirely when no project is open. Defaults to shown. */
  showMemory?: boolean;
  sessionsOpen?: boolean;
  sessionCount?: number;
  onToggleSessions?: () => void;
  /**
   * Hide the sessions affordance when no project is open, exactly as `showMemory` does. Sessions
   * belong to a project, so with no project there is nothing to list and no reason to occupy the
   * bar (`plans/codecanvas-session-widget/`, Slice 02).
   */
  showSessions?: boolean;
}

/**
 * The single bottom-right control instrument: the zoom segment, a hairline divider, then the
 * project-memory button (label reveals on hover/open, count badge, accent tint when open). One
 * glass object instead of two competing pills. Quiet-at-rest opacity is CSS-driven on the bar.
 */
export const CanvasCornerControlBar = memo(function CanvasCornerControlBar({
  zoom,
  bounds,
  onFitAll,
  onZoomIn,
  onZoomOut,
  memoryOpen,
  memoryCount,
  onToggleMemory,
  showMemory = true,
  sessionsOpen = false,
  sessionCount = 0,
  onToggleSessions,
  showSessions = false,
}: CanvasCornerControlBarProps) {
  // Publish this bar's live width so the NL command bar's "bottom strip" design can reserve exactly
  // enough room to clear it. The bar's width is variable (the memory button is conditional, the zoom
  // label grows with the percentage), which is why a hardcoded reservation overlapped it before.
  const barRef = useRef<HTMLDivElement>(null);
  usePublishedElementWidth(barRef, "--canvas-corner-bar-w");
  // Hidden at rest; the corner or a zoom change wakes it (S1b). Hold states are CSS.
  const awake = useCornerControlsWake(barRef, zoom);

  return (
    <div
      ref={barRef}
      className={`canvas-corner-bar${memoryOpen ? " is-memory-open" : ""}${sessionsOpen ? " is-sessions-open" : ""}`}
      role="group"
      aria-label="Canvas controls"
      data-awake={awake ? "true" : undefined}
    >
      <CanvasZoomControlView
        zoom={zoom}
        bounds={bounds}
        onFitAll={onFitAll}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
      />
      {showMemory ? (
        <>
          <span className="canvas-corner-divider" aria-hidden />
          <button
            type="button"
            className={`canvas-corner-memory${memoryOpen ? " is-open" : ""}`}
            aria-label="Project memory"
            aria-expanded={memoryOpen}
            onClick={onToggleMemory}
          >
            <Brain size={15} aria-hidden />
            <span className="canvas-corner-memory-label">Memory</span>
            {memoryCount > 0 ? <span className="canvas-corner-memory-count">{memoryCount}</span> : null}
          </button>
        </>
      ) : null}
      {showSessions && onToggleSessions ? (
        <>
          <span className="canvas-corner-divider" aria-hidden />
          <button
            type="button"
            className={`canvas-corner-sessions${sessionsOpen ? " is-open" : ""}`}
            aria-label="Sessions"
            aria-expanded={sessionsOpen}
            onClick={onToggleSessions}
          >
            <MessagesSquare size={15} aria-hidden />
            <span className="canvas-corner-sessions-label">Sessions</span>
            {sessionCount > 0 ? <span className="canvas-corner-sessions-count">{sessionCount}</span> : null}
          </button>
        </>
      ) : null}
    </div>
  );
});
