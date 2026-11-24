"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Pause, Square } from "lucide-react";
import { useCanvasOcclusionLock } from "../../hooks/useCanvasOcclusionLock";

export interface RunNodeMenuProps {
  /** Set while the run can still be paused: new steps stop, running ones finish. */
  onPause?: () => void;
  /** Set while there is a run to end for good (live, pausing, paused or interrupted). */
  onAbort?: () => void;
}

/**
 * The Run Node's ⋯ menu (#114, mockups/lotus-graph-run.pen S9): Pause and Abort, on the card and
 * on the open group's header. Hidden when neither applies. The list is a portal, so it stays a
 * readable size at any canvas zoom; it reuses the Frame tab menu's look.
 */
export function RunNodeMenu({ onPause, onAbort }: RunNodeMenuProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  if (!onPause && !onAbort) return null;
  return (
    <>
      <button
        type="button"
        className="run-card-icon nodrag"
        aria-label="Run menu"
        title="Pause or abort"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor((a) => (a ? null : rect));
        }}
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {anchor ? <RunNodeMenuList anchor={anchor} onPause={onPause} onAbort={onAbort} onClose={close} /> : null}
    </>
  );
}

function RunNodeMenuList({ anchor, onPause, onAbort, onClose }: RunNodeMenuProps & { anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useCanvasOcclusionLock(true, "run-node-menu");

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const pick = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return createPortal(
    <div
      ref={ref}
      className="canvas-frame-tab-menu run-node-menu nodrag nopan"
      role="menu"
      aria-label="Run menu"
      // Right-aligned under the button: it sits at the right end of the card and the header.
      style={{ right: Math.max(8, window.innerWidth - anchor.right), top: anchor.bottom + 6 }}
    >
      {onPause ? (
        <button type="button" role="menuitem" className="canvas-frame-tab-menu-item" onClick={pick(onPause)}>
          <Pause size={15} aria-hidden="true" />
          <span className="canvas-frame-tab-menu-label">
            Pause
            <small>Running steps finish, then it waits for Resume</small>
          </span>
        </button>
      ) : null}
      {onAbort ? (
        <button type="button" role="menuitem" className="canvas-frame-tab-menu-item canvas-frame-tab-menu-item--danger" onClick={pick(onAbort)}>
          <Square size={15} aria-hidden="true" />
          <span className="canvas-frame-tab-menu-label">
            Abort
            <small>No new steps. A step already running finishes on its own</small>
          </span>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
