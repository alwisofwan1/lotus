"use client";
import { useEffect, useState } from "react";

// Phase 2 (ADR-0023): video paper must not burn battery/GPU on an already-heavy
// React Flow surface. This decides whether a looping background video should play.
// Pure decision split out for testing; the hook just wires the browser signals.

export interface VideoPolicyInputs {
  /** document.hidden — tab/window not visible. */
  hidden: boolean;
  /** prefers-reduced-motion: reduce. */
  reducedMotion: boolean;
}

export function computeVideoShouldPlay({ hidden, reducedMotion }: VideoPolicyInputs): boolean {
  return !hidden && !reducedMotion;
}

/**
 * True when a background video should be playing. Pauses when the window is
 * hidden or the user prefers reduced motion. (Zoom-based pause needs the React
 * Flow store and is a follow-up; the poster frame covers the paused state.)
 */
export function useCanvasVideoPolicy(): boolean {
  const [hidden, setHidden] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    onVis();
    document.addEventListener("visibilitychange", onVis);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMq = () => setReducedMotion(mq.matches);
    onMq();
    mq.addEventListener?.("change", onMq);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      mq.removeEventListener?.("change", onMq);
    };
  }, []);

  return computeVideoShouldPlay({ hidden, reducedMotion });
}
