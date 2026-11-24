"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * When the bottom-right corner controls show (`plans/canvas-dock/` S1b, `.pen` frame 15 "Corner
 * controls hidden by default": Rest / Approach / Zoom / Hold).
 *
 * - **Approach:** the pointer enters the corner — the bar's own box grown by `reach` up and to the
 *   left, running to the window's bottom-right edge.
 * - **Zoom:** the zoom level changed, from any source (pinch, wheel, ⌘+/-, Fit). Pan alone keeps
 *   the zoom, so it does nothing.
 * - **Rest:** `linger` after the pointer leaves, or after the last zoom change.
 *
 * Hold (focus inside, an open popover) is CSS, on the bar's own state classes.
 *
 * The corner is watched with a passive window `pointermove`, not an invisible hit area: a box laid
 * over the canvas would eat the drags and pans that start in that corner.
 */
export interface CornerWakeOptions {
  /** How far past the bar, up and to the left, the corner reaches. */
  reach?: { x: number; y: number };
  linger?: number;
}

export const CORNER_REACH = { x: 64, y: 56 } as const;
export const CORNER_LINGER_MS = 1600;

export function useCornerControlsWake(
  barRef: RefObject<HTMLElement | null>,
  zoom: number,
  { reach = CORNER_REACH, linger = CORNER_LINGER_MS }: CornerWakeOptions = {},
): boolean {
  const [awake, setAwake] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inside = useRef(false);

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const restLater = useCallback(() => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!inside.current) setAwake(false);
    }, linger);
  }, [linger]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const bar = barRef.current;
      if (!bar) return;
      const box = bar.getBoundingClientRect();
      const within = event.clientX >= box.left - reach.x && event.clientY >= box.top - reach.y;
      if (within === inside.current) return;
      inside.current = within;
      if (within) {
        clear();
        setAwake(true);
      } else {
        restLater();
      }
    };
    // Leaving the window is leaving the corner: no further pointermove would ever say so.
    const onLeave = () => {
      if (!inside.current) return;
      inside.current = false;
      restLater();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [barRef, reach.x, reach.y, restLater]);

  const lastZoom = useRef(zoom);
  useEffect(() => {
    if (lastZoom.current === zoom) return;
    lastZoom.current = zoom;
    setAwake(true);
    restLater();
  }, [zoom, restLater]);

  useEffect(() => clear, []);

  return awake;
}
