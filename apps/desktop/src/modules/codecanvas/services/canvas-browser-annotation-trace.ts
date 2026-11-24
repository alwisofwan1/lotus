// Canvas Browser Annotation Trace — Verify-First Instrumentation (Slice 0)
//
// Shared by every frontend annotation delivery path (the event-filtering hook and
// the terminal-routing service) so a live repro produces one grep-friendly line
// shape, correlated by `terminal=`/`id=` with the matching Rust-side trace lines
// (`format_annotation_trace` / `annotation_trace_id` in canvas_browser.rs).
// Zero imports from src/modules/codespace/.

import { isTauri } from "@/lib/tauri/runtime";
import { logCanvasBrowserAnnotationTrace } from "@/lib/tauri/canvas-browser";

/** Build a trace line. `path` names the delivery stage emitting it (e.g.
 *  "frontend-hook", "frontend-route") so a grep for one `id=` shows the full
 *  cross-layer journey of a single annotation submission. */
export function formatAnnotationTrace(
  path: string,
  terminalId: string,
  annotationId: string,
  detail: string,
): string {
  return `[canvas][annotation-trace] path=${path} terminal=${terminalId} id=${annotationId} detail=${detail}`;
}

/** Best-effort extraction of the annotation's own `id` field from a raw payload
 *  string, for trace correlation before (or without) full payload parsing.
 *  Returns "-" for malformed JSON, a non-object payload, or a missing/non-string id. */
export function extractAnnotationTraceId(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return "-";
    const id = (parsed as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : "-";
  } catch {
    return "-";
  }
}

/** Default trace sink for every delivery path in this module: always visible in
 *  the browser/WebView DevTools console, and — inside Tauri — also relayed into
 *  the Rust dev terminal (stderr) so a live repro reads from one place instead
 *  of needing both the terminal and the WebView inspector open. Best-effort:
 *  the relay is fire-and-forget and never throws back into the caller. */
export function logAnnotationTrace(line: string): void {
  console.debug(line);
  if (!isTauri()) return;
  void logCanvasBrowserAnnotationTrace(line).catch(() => {
    // The line already reached the browser console above; the Rust relay is
    // a best-effort convenience, not the source of truth.
  });
}
