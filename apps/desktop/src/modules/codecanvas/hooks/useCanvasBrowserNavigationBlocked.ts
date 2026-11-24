"use client";

import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

/** Tauri event emitted by the Rust navigation handler when a page-initiated
 * navigation is rejected by the node's origin policy. Without a listener the
 * block is invisible and reads as a broken/blank browser. */
export const CANVAS_BROWSER_NAVIGATION_BLOCKED_EVENT = "canvas://browser-navigation-blocked";

interface UseCanvasBrowserNavigationBlockedOptions {
  /** Stable native WebView identity. Paired browsers use their parent Canvas Terminal ID. */
  nativeBrowserId: string;
  /** Called with the blocked URL when this node's policy rejects a navigation. */
  onBlocked: (url: string) => void;
}

export function useCanvasBrowserNavigationBlocked({
  nativeBrowserId,
  onBlocked,
}: UseCanvasBrowserNavigationBlockedOptions): void {
  const unlistenRef = useRef<(() => void) | null>(null);
  const nativeBrowserIdRef = useRef(nativeBrowserId);
  const onBlockedRef = useRef(onBlocked);
  nativeBrowserIdRef.current = nativeBrowserId;
  onBlockedRef.current = onBlocked;

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ terminalId?: string; url?: string }>(
          CANVAS_BROWSER_NAVIGATION_BLOCKED_EVENT,
          (event) => {
            if (cancelled) return;
            if (event.payload.terminalId !== nativeBrowserIdRef.current) return;
            const url = event.payload.url;
            if (typeof url !== "string" || !url.trim()) return;
            onBlockedRef.current(url);
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
}
