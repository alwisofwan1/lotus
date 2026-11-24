"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import {
  applySplitSnap,
  nudgeSplitSize,
  resolveDragSize,
} from "@/modules/workspace-shell/services/split-sizing";

export type SplitOrientation = "vertical" | "horizontal";

interface SplitHandleProps {
  /** `vertical` is a vertical seam between two columns — it resizes a WIDTH. */
  orientation: SplitOrientation;
  /** Current size of the pane this seam sizes — see `sizes`. */
  size: number;
  /**
   * Which side of the seam `size` measures. `before` (the default) is the pane to the left or
   * above; `after` is the pane to the right or below — a right-hand panel, which must grow when
   * the seam is pulled LEFT. Without it that panel resized backwards.
   */
  sizes?: "before" | "after";
  min: number;
  max: number;
  /** Where a double-click puts the seam back, and what the drag snaps to on the way past. */
  defaultSize: number;
  label: string;
  onResize: (size: number) => void;
  onResizeEnd?: (size: number) => void;
  className?: string;
}

const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_LARGE = 64;
const DRAGGING_BODY_CLASS = "ws-split-dragging";

/**
 * The seam between two panes, and the only thing that says a seam is draggable.
 *
 * The grip is three dots, not a line: a 1px rule reads as decoration, and users look for the
 * dots because VS Code, Zed and Finder all put them there. The hit zone is the whole 14px
 * track — the dots are a label for it, not the target.
 */
export function SplitHandle({
  orientation,
  size,
  sizes = "before",
  min,
  max,
  defaultSize,
  label,
  onResize,
  onResizeEnd,
  className,
}: SplitHandleProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startPos: number; startSize: number } | null>(null);
  const vertical = orientation === "vertical";
  /** +1 when moving the pointer right/down grows the sized pane, −1 when it shrinks it. */
  const sign = sizes === "after" ? -1 : 1;

  // The cursor has to survive the pointer leaving the 14px track mid-drag, so it is owned by
  // the document for the duration instead of by the element under the pointer.
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add(DRAGGING_BODY_CLASS);
    document.body.dataset.wsSplitAxis = vertical ? "vertical" : "horizontal";
    return () => {
      document.body.classList.remove(DRAGGING_BODY_CLASS);
      delete document.body.dataset.wsSplitAxis;
    };
  }, [dragging, vertical]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startPos: vertical ? event.clientX : event.clientY,
        startSize: size,
      };
      setDragging(true);
    },
    [size, vertical],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const delta = sign * ((vertical ? event.clientX : event.clientY) - drag.startPos);
      const next = resolveDragSize(drag.startSize, delta, { min, max });
      onResize(applySplitSnap(next, defaultSize));
    },
    [defaultSize, max, min, onResize, sign, vertical],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onResizeEnd?.(size);
    },
    [onResizeEnd, size],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const decrease = vertical ? "ArrowLeft" : "ArrowUp";
      const increase = vertical ? "ArrowRight" : "ArrowDown";
      const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;

      if (event.key === decrease || event.key === increase) {
        event.preventDefault();
        const direction = (event.key === increase ? 1 : -1) * sign;
        const next = nudgeSplitSize(size, direction * step, { min, max });
        onResize(next);
        onResizeEnd?.(next);
        return;
      }

      // Home is the keyboard twin of the double-click: one key puts the seam back.
      if (event.key === "Home" || event.key === "Enter") {
        event.preventDefault();
        onResize(defaultSize);
        onResizeEnd?.(defaultSize);
      }
    },
    [defaultSize, max, min, onResize, onResizeEnd, sign, size, vertical],
  );

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-dragging={dragging ? "true" : undefined}
      className={cn("ws-split", `ws-split--${orientation}`, className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        onResize(defaultSize);
        onResizeEnd?.(defaultSize);
      }}
      onKeyDown={handleKeyDown}
    >
      <span className="ws-split-grip" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
