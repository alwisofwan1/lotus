"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import {
  startCanvasBrowserAnnotationMode,
  stopCanvasBrowserAnnotationMode,
} from "@/lib/tauri/canvas-browser";
import {
  storeCanvasBrowserAnnotation,
  getLatestCanvasBrowserAnnotation,
  clearCanvasBrowserAnnotation,
  type CanvasBrowserAnnotationEntry,
} from "../services/canvas-browser-annotation";
import { extractAnnotationTraceId, formatAnnotationTrace, logAnnotationTrace } from "../services/canvas-browser-annotation-trace";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

const TRACE_PATH = "frontend-hook";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UseCanvasBrowserAnnotationOptions {
  /** Stable native WebView identity. Paired browsers use their parent Canvas Terminal ID. */
  nativeBrowserId: string;
  /** Called after a valid native annotation event is captured for this browser. */
  onAnnotationCaptured?: (entry: CanvasBrowserAnnotationEntry) => void;
  /** Verify-first instrumentation (Slice 0): grep-friendly trace for every
   *  incoming `canvas://browser-annotation` event, whether accepted by this
   *  hook instance or dropped because the event's terminalId belongs to a
   *  different Browser Node. Defaults to `logAnnotationTrace` (console + a
   *  best-effort relay into the Rust dev terminal). */
  log?: (line: string) => void;
}

interface UseCanvasBrowserAnnotationResult {
  annotationActive: boolean;
  toggleAnnotation: () => void;
  latestAnnotation: CanvasBrowserAnnotationEntry | null;
  clearAnnotation: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCanvasBrowserAnnotation(
  options: UseCanvasBrowserAnnotationOptions,
): UseCanvasBrowserAnnotationResult {
  const { nativeBrowserId, onAnnotationCaptured, log = logAnnotationTrace } = options;
  const [annotationActive, setAnnotationActive] = useState(false);
  const [latestAnnotation, setLatestAnnotation] = useState<CanvasBrowserAnnotationEntry | null>(
    () => getLatestCanvasBrowserAnnotation(nativeBrowserId) ?? null,
  );
  const unlistenRef = useRef<(() => void) | null>(null);
  const nativeBrowserIdRef = useRef(nativeBrowserId);
  const onAnnotationCapturedRef = useRef(onAnnotationCaptured);
  const logRef = useRef(log);
  nativeBrowserIdRef.current = nativeBrowserId;
  onAnnotationCapturedRef.current = onAnnotationCaptured;
  logRef.current = log;

  // Subscribe to Tauri annotation events for this terminal.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ terminalId: string; payload: string; source?: "native" | "navigation" }>(
          "canvas://browser-annotation",
          (event) => {
            if (cancelled) return;
            const annotationTraceId = extractAnnotationTraceId(event.payload.payload);
            if (event.payload.terminalId !== nativeBrowserIdRef.current) {
              logRef.current(
                formatAnnotationTrace(
                  TRACE_PATH,
                  event.payload.terminalId,
                  annotationTraceId,
                  `dropped:terminal-mismatch(node=${nativeBrowserIdRef.current})`,
                ),
              );
              return;
            }
            logRef.current(formatAnnotationTrace(TRACE_PATH, event.payload.terminalId, annotationTraceId, "accepted"));

            const entry: CanvasBrowserAnnotationEntry = {
              terminalId: event.payload.terminalId,
              payload: event.payload.payload,
              capturedAt: Date.now(),
              source: event.payload.source ?? "navigation",
            };
            storeCanvasBrowserAnnotation(entry);
            setLatestAnnotation(entry);
            setAnnotationActive(false);
            onAnnotationCapturedRef.current?.(entry);
          },
        ),
      )
      .then((unlisten) => {
        if (cancelled) safeTauriUnlisten(unlisten);
        else unlistenRef.current = unlisten;
      })
      .catch(() => {
        // @tauri-apps/api/event unavailable in browser dev mode — no-op.
      });

    return () => {
      cancelled = true;
      safeTauriUnlisten(unlistenRef.current);
      unlistenRef.current = null;
    };
  }, []);

  const toggleAnnotation = useCallback(() => {
    if (annotationActive) {
      setAnnotationActive(false);
      void stopCanvasBrowserAnnotationMode(nativeBrowserIdRef.current).catch(() => {
        // Annotation overlay cleanup is best-effort; the native WebView may have closed already.
      });
      return;
    }

    void startCanvasBrowserAnnotationMode(nativeBrowserIdRef.current)
      .then(() => setAnnotationActive(true))
      .catch(() => setAnnotationActive(false));
  }, [annotationActive]);

  const clearAnnotation = useCallback(() => {
    clearCanvasBrowserAnnotation(nativeBrowserIdRef.current);
    setLatestAnnotation(null);
  }, []);

  return { annotationActive, toggleAnnotation, latestAnnotation, clearAnnotation };
}
