"use client";
import { useEffect, useRef } from "react";
import type { CanvasBrowserState } from "../types/canvas";
import { isBlankCanvasBrowserUrl } from "../runtime/adapters/canvas-browser-lifecycle-adapter";

export interface UseCanvasBrowserAutoOpenOptions {
  nodeId: string;
  initialUrl: string;
  initialState: CanvasBrowserState;
  browserState: CanvasBrowserState;
  openBrowser: (url?: string) => Promise<void>;
}

export function useCanvasBrowserAutoOpen({
  nodeId,
  initialUrl,
  initialState,
  browserState,
  openBrowser,
}: UseCanvasBrowserAutoOpenOptions): void {
  const autoOpenRequestKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialState !== "loading" || isBlankCanvasBrowserUrl(initialUrl)) return;

    const requestKey = `${nodeId}\n${initialUrl}`;
    if (autoOpenRequestKeyRef.current === requestKey) return;

    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      autoOpenRequestKeyRef.current = requestKey;
      void openBrowser(initialUrl);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [nodeId, initialState, initialUrl, openBrowser]);

  useEffect(() => {
    if (browserState === "disconnected") {
      autoOpenRequestKeyRef.current = null;
    }
  }, [browserState]);
}
