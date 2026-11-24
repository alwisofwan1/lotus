"use client";

// Canvas Browser Annotation Context — shared parse + format
//
// Pure payload→context conversion, extracted so every delivery mechanism (classic
// Terminal PTY routing, live-agent reply routing) formats an annotation the same
// way instead of maintaining duplicate copies. Zero imports from
// src/modules/codespace/ services other than the payload contract parser.

import { parseBrowserAnnotationPayload } from "@/modules/codespace/services/browser-annotation-contract";
import type { BrowserAnnotation } from "@/lib/tauri/codespace";
import { pickDetails, pickFrom } from "@/modules/chat/domain/preview";
import { computeAnnotationScreenshotCropRect, type AnnotationScreenshotCropRect } from "./canvas-browser-annotation-crop";

export type ParsedCanvasBrowserAnnotationContext =
  | {
      ok: true;
      annotationId: string;
      context: string;
      /** Margin-expanded, viewport-relative rect for the selected element, ready
       *  for `WKSnapshotConfiguration.rect` — null when there's nothing sensible
       *  to crop (e.g. a zero-size box). */
      cropRect: AnnotationScreenshotCropRect | null;
    }
  | { ok: false; reason: "attachment-metadata-only" | "malformed-json" | "invalid-payload" | "unsupported-action" };

function visualAttachmentPaths(payload: string): string[] {
  try {
    const parsed = JSON.parse(payload) as { visualAttachments?: unknown };
    if (!Array.isArray(parsed.visualAttachments)) return [];
    return parsed.visualAttachments.flatMap((attachment) => {
      if (!attachment || typeof attachment !== "object") return [];
      const path = (attachment as Record<string, unknown>).path;
      return typeof path === "string" && path ? [path] : [];
    });
  } catch {
    return [];
  }
}

function isVisualAttachmentMetadataOnly(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as { visualAttachments?: unknown };
    return Array.isArray(parsed.visualAttachments) && parsed.visualAttachments.length > 0 && visualAttachmentPaths(payload).length === 0;
  } catch {
    return false;
  }
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\n/g, " ");

/**
 * The same `<pick />` line the chat sends, plus where the pictures were saved: a terminal gets one
 * short block it can act on, not a recipe and a page of details.
 */
function formatCanvasAnnotationContext(annotation: BrowserAnnotation, picturePaths: string[]): string {
  const pick = pickFrom(annotation);
  const parts = [`page="${attr(annotation.url)}"`, `selector="${attr(annotation.selector || "body")}"`, `element="${attr(pick?.tag ?? "element")}"`];
  if (pick?.text) parts.push(`text="${attr(pick.text)}"`);
  if (pick) parts.push(...pickDetails(pick));
  const box = annotation.boundingBox;
  if (box.width > 0 || box.height > 0) parts.push(`box="${box.x},${box.y} ${box.width}x${box.height}"`);
  for (const path of picturePaths) parts.push(`picture="${attr(path)}"`);
  return `<picked-elements>\n<pick ${parts.join(" ")} />\n</picked-elements>\n\n${annotation.message?.trim() ?? ""}`.trim();
}

/** Parse a raw overlay payload string into agent-readable context, or a reason
 *  it can't be delivered (metadata-only attachment follow-up, malformed JSON,
 *  or a payload that isn't a human "selected" annotation). Callers own what
 *  "no delivery target" means for their own routing mechanism. */
export function parseCanvasBrowserAnnotationContext(payload: string): ParsedCanvasBrowserAnnotationContext {
  if (isVisualAttachmentMetadataOnly(payload)) return { ok: false, reason: "attachment-metadata-only" };

  const parsed = parseBrowserAnnotationPayload(payload);
  if (parsed.kind !== "selected") return { ok: false, reason: parsed.reason };

  const attachmentPaths = visualAttachmentPaths(payload);
  return {
    ok: true,
    annotationId: parsed.annotation.id,
    context: formatCanvasAnnotationContext(parsed.annotation, attachmentPaths),
    cropRect: computeAnnotationScreenshotCropRect(parsed.annotation),
  };
}
