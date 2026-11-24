"use client";

import { useEffect, useState } from "react";
import { useElementSize, type ElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import { hasSettledSize, shouldFitTerminal } from "@/modules/workspace-shell/services/terminal-fit";

/**
 * An element's size, reported only once it has stopped changing.
 *
 * Returns `null` until the box has held still for a frame, so a consumer that can only be given
 * a size ONCE — a terminal, which fits its character grid at mount — is never handed a number
 * the layout is still in the middle of deciding.
 *
 * The wait is a frame rather than a comparison in an effect: measuring, laying out and painting
 * all happen within one, so "still the same next frame" is the cheapest honest definition of
 * settled, and it keeps the state update out of the effect body.
 */
export function useSettledElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  ElementSize | null,
] {
  const [ref, size] = useElementSize<T>();
  const [settled, setSettled] = useState<ElementSize | null>(null);

  useEffect(() => {
    if (!shouldFitTerminal(size)) return;

    const handle = requestAnimationFrame(() => {
      setSettled((current) => (current && hasSettledSize(current, size) ? current : size));
    });
    return () => cancelAnimationFrame(handle);
  }, [size]);

  return [ref, settled];
}
