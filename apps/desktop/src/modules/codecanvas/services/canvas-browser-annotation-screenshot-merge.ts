"use client";

// Canvas Browser Annotation Screenshot Merge
//
// Captures the native region screenshot and merges its path into the
// annotation payload BEFORE routing, so the agent receives ONE combined
// submission (text + screenshot) instead of two separate turns. A CLI agent's
// reply mechanism (`sendReply`/PTY write) treats each call as its own turn —
// sending the screenshot as a later follow-up made the agent answer twice for
// one user action, which reads as a broken "double submit," not enrichment.

import { captureCanvasBrowserAnnotationScreenshot } from "@/lib/tauri/canvas-browser";
import { computeAnnotationScreenshotCropRect } from "./canvas-browser-annotation-crop";
import type { BrowserAnnotation } from "@/lib/tauri/codespace";

/** Best-effort: capture a screenshot cropped to the selected element (via the
 *  raw payload's own `boundingBox`/`viewport`) and return the payload with a
 *  synthetic `visualAttachments` entry pointing at it. On any failure —
 *  malformed payload, capture error/timeout — returns the ORIGINAL payload
 *  unchanged so the text annotation still delivers on its own. */
export async function augmentAnnotationPayloadWithScreenshot(
  payload: string,
  nativeBrowserId: string,
  capture: typeof captureCanvasBrowserAnnotationScreenshot = captureCanvasBrowserAnnotationScreenshot,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!parsed || typeof parsed !== "object") return payload;
  const record = parsed as Record<string, unknown>;

  const cropRect = computeAnnotationScreenshotCropRect(record as unknown as BrowserAnnotation);

  let path: string;
  try {
    path = await capture(nativeBrowserId, cropRect);
  } catch {
    return payload;
  }

  return JSON.stringify({
    ...record,
    visualAttachments: [{ name: "selected-region.png", path, mimeType: "image/png" }],
  });
}
