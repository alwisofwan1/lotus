"use client";
import { useLayoutEffect } from "react";
import { acquireCanvasOcclusion } from "../services/canvas-occlusion-store";

/**
 * Hold a blocking occlusion lock while `active` is true. A blocking overlay (modal, dialog, menu)
 * calls this with its `open` prop; while held, Canvas Browser Nodes park their native WebView so
 * the overlay is not painted under it.
 *
 * Acquisition runs in useLayoutEffect (not useEffect) so the park is requested before the browser
 * paints the frame that shows the overlay, avoiding a flash of the page over the modal. The lock is
 * released on close and on unmount-while-open.
 */
export function useCanvasOcclusionLock(active: boolean, label?: string): void {
  useLayoutEffect(() => {
    if (!active) return;
    return acquireCanvasOcclusion(label);
  }, [active, label]);
}
