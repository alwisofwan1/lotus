"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Live size of an element. The seam's maximum depends on how much room the container has, so
 * it has to be measured rather than assumed — a stored pixel width from a wide window must not
 * leave the trailing pane at zero on a narrow one.
 */
export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Returns a ref callback and the size as separate values: a size read during render is state,
 * not a ref.
 *
 * The ref is a CALLBACK, not a `useRef`, and that is load-bearing. An observer attached once in
 * an effect keeps watching the element it saw at mount; when the surrounding tree swaps that
 * element out — a wizard taking over the body and handing it back — the observer stays pointed
 * at a detached node, reports 0 forever, and every width computed from it collapses. Measured on
 * 2026-09-20: pane seams never appeared because the row they belonged to was never measured.
 */
export function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, ElementSize] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  const ref = useCallback((next: T | null) => setNode(next), []);

  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;

    // No manual seeding: a ResizeObserver reports the current size on `observe`, so the first
    // measurement arrives on its own — and setting state synchronously here would just cascade
    // an extra render before it.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [ref, size];
}
