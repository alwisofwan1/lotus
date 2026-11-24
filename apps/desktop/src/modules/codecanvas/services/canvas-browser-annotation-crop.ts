"use client";

// Canvas Browser Annotation Crop — bounding box → self-calibrating crop rect
//
// Pure conversion of a captured annotation's page-absolute bounding box into a
// margin-expanded, viewport-relative rect in CSS pixels, carried ALONGSIDE the CSS
// viewport dimensions it was measured against. Rust crops a full-viewport snapshot
// using scale = png_dim / viewport_dim (see canvas_browser_screenshot.rs) — so the
// browser's page zoom (`setPageZoom`), device pixel ratio, and magnification all
// cancel out, because the scale is measured from the real capture rather than
// assumed. This deliberately does NOT feed WKSnapshotConfiguration.rect, whose
// view-coordinate space diverges from getBoundingClientRect() under page zoom.
// Zero imports from src/modules/codespace/ other than the type.

import type { BrowserAnnotation } from "@/lib/tauri/codespace";

/** Extra padding around the element's box, as a fraction of its size. Default 0:
 *  the crop is tight to exactly what the user selected — no adjacent thumbnails or
 *  captions bleeding in. Callers may opt into a margin for extra surrounding context. */
export const ANNOTATION_SCREENSHOT_CROP_MARGIN_RATIO = 0;

export interface AnnotationScreenshotCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** CSS viewport the rect was measured against — Rust divides the captured PNG
   *  dimensions by these to recover the true CSS→pixel scale (self-calibration). */
  viewportWidth: number;
  viewportHeight: number;
}

/** Returns null when there's nothing sensible to crop (a zero-size box or
 *  viewport) — callers fall back to an uncropped full-viewport screenshot. */
export function computeAnnotationScreenshotCropRect(
  annotation: BrowserAnnotation,
  marginRatio: number = ANNOTATION_SCREENSHOT_CROP_MARGIN_RATIO,
): AnnotationScreenshotCropRect | null {
  const { boundingBox, viewport } = annotation;
  if (boundingBox.width <= 0 || boundingBox.height <= 0) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;

  const viewportRelativeX = boundingBox.x - viewport.scrollX;
  const viewportRelativeY = boundingBox.y - viewport.scrollY;
  const marginX = boundingBox.width * marginRatio;
  const marginY = boundingBox.height * marginRatio;

  const x0 = Math.max(0, viewportRelativeX - marginX);
  const y0 = Math.max(0, viewportRelativeY - marginY);
  const x1 = Math.min(viewport.width, viewportRelativeX + boundingBox.width + marginX);
  const y1 = Math.min(viewport.height, viewportRelativeY + boundingBox.height + marginY);

  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;

  return { x: x0, y: y0, width, height, viewportWidth: viewport.width, viewportHeight: viewport.height };
}
