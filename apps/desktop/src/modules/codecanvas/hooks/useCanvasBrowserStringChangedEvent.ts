"use client";

import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

interface UseCanvasBrowserStringChangedEventOptions {
  eventName: string;
  nativeBrowserId: string;
  field: "title" | "url";
  onChanged: (value: string) => void;
}

export function useCanvasBrowserStringChangedEvent({
  eventName,
  nativeBrowserId,
  field,
  onChanged,
}: UseCanvasBrowserStringChangedEventOptions): void {
  const unlistenRef = useRef<(() => void) | null>(null);
  const nativeBrowserIdRef = useRef(nativeBrowserId);
  const onChangedRef = useRef(onChanged);
  nativeBrowserIdRef.current = nativeBrowserId;
  onChangedRef.current = onChanged;

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<Record<string, unknown>>(eventName, (event) => {
          if (cancelled) return;
          if (event.payload.terminalId !== nativeBrowserIdRef.current) return;
          const value = event.payload[field];
          if (typeof value !== "string" || !value.trim()) return;
          onChangedRef.current(value);
        }),
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
  }, [eventName, field]);
}
