"use client";
import { useEffect, useId } from "react";
import type { RefObject } from "react";
import { registerDockedOccluder, notifyDockedOccluders } from "../services/canvas-occlusion-store";
import { dockedOccluderEdgeStrip, type CanvasDockedEdge } from "../services/viewport/canvas-viewport-policy";

export interface UseDockedOccluderOptions {
  /**
   * Clip the browser past the area-fraction cap. Set for edge-anchored dropdowns that MUST be
   * cleared (else they render under the WebView); leave off for thin auto-docks (NL bar, rail)
   * where the cap sensibly prevents over-clipping.
   */
  force?: boolean;
  /**
   * Anchor the occluder to a viewport edge, expanding the element's rect into a full-edge strip.
   * A dropdown is a corner rect whose least-area cut is ambiguous; anchoring it to its docking edge
   * (e.g. "bottom" for a menu that opens upward) makes the browser's clip a clean, deterministic
   * single-edge cut so the menu is never left partly covered.
   */
  edge?: CanvasDockedEdge;
}

/**
 * Register an edge-docked element (NL command bar, focus rail, project dropdown) as a docked
 * occluder while `active`. Canvas Browser Nodes clip their native WebView bounds to avoid it
 * instead of parking entirely. The element's own resize is observed so browser nodes re-clip when
 * the dock grows/shrinks.
 */
export function useDockedOccluder(
  ref: RefObject<HTMLElement | null>,
  active = true,
  options: UseDockedOccluderOptions = {},
): void {
  const id = useId();
  const force = options.force ?? false;
  const edge = options.edge;
  useEffect(() => {
    if (!active) return;
    const unregister = registerDockedOccluder(id, () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return null;
      const base = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      const shaped = edge
        ? dockedOccluderEdgeStrip(base, edge, {
            left: 0,
            top: 0,
            right: typeof window !== "undefined" ? window.innerWidth : rect.right,
            bottom: typeof window !== "undefined" ? window.innerHeight : rect.bottom,
          })
        : base;
      return { ...shaped, force };
    });
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => notifyDockedOccluders())
      : null;
    if (ref.current) observer?.observe(ref.current);
    return () => {
      observer?.disconnect();
      unregister();
    };
  }, [id, active, ref, force, edge]);
}
