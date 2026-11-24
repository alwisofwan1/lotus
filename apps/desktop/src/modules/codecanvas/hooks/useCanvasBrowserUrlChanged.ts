"use client";

import { useCanvasBrowserStringChangedEvent } from "./useCanvasBrowserStringChangedEvent";

/** Tauri event emitted by the Rust navigation handler when the paired WebView
 * commits to a new top-level URL (link click, redirect, programmatic navigation).
 * Lets the address bar follow the page like a real browser, not just reflect URLs
 * the app itself set. */
export const CANVAS_BROWSER_URL_CHANGED_EVENT = "canvas://browser-url-changed";

interface UseCanvasBrowserUrlChangedOptions {
  /** Stable native WebView identity. Paired browsers use their parent Canvas Terminal ID. */
  nativeBrowserId: string;
  /** Called with the new URL when the WebView navigates to it. */
  onUrlChanged: (url: string) => void;
}

export function useCanvasBrowserUrlChanged({
  nativeBrowserId,
  onUrlChanged,
}: UseCanvasBrowserUrlChangedOptions): void {
  useCanvasBrowserStringChangedEvent({
    eventName: CANVAS_BROWSER_URL_CHANGED_EVENT,
    nativeBrowserId,
    field: "url",
    onChanged: onUrlChanged,
  });
}
