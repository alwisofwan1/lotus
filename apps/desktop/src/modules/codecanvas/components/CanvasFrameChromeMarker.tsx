"use client";
import { Panel, useStore } from "@xyflow/react";
import { FRAME_CHROME_ZOOM } from "../services/canvas-frame-space";

/**
 * Hidden marker that lets CSS hide every Frame's chrome (border, tint, title tab, grips) while the
 * camera is zoomed in (decision 32). The selector returns a boolean, so React re-renders only when
 * the zoom crosses the threshold, never per zoom tick, and no Frame node re-renders at all: the CSS
 * (styles/canvas/canvas-frame-node.css) reads `data-frame-chrome` through `:has`.
 */
export function CanvasFrameChromeMarker() {
  const zoomedIn = useStore((s) => s.transform[2] >= FRAME_CHROME_ZOOM);
  return <Panel position="top-left" className="canvas-frame-chrome-marker" data-frame-chrome={zoomedIn ? "off" : "on"} aria-hidden />;
}
