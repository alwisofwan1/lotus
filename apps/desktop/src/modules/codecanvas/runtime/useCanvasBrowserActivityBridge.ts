"use client";
import { useEffect } from "react";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { setCanvasBrowserActivity } from "../services/canvas-browser-activity-store";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

/**
 * Listens for `canvas://browser-activity` (emitted by the Rust browser handlers when an agent starts
 * / finishes a snapshot, click, type, or search) and feeds the activity store that drives the
 * Browser Node's "agent is using this browser" badge. Mounted once at the page level.
 */
export function useCanvasBrowserActivityBridge() {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<{ terminalId?: string; active?: boolean }>(
        "canvas://browser-activity",
        ({ payload }) => {
          if (payload?.terminalId) setCanvasBrowserActivity(payload.terminalId, Boolean(payload.active));
        },
      );
      if (disposed) {
        safeTauriUnlisten(un);
        return;
      }
      unlisten = un;
    })().catch((err: unknown) => {
      if (!disposed) console.warn("[canvas-browser-activity] listener setup failed", err);
    });

    return () => {
      disposed = true;
      safeTauriUnlisten(unlisten);
    };
  }, []);
}
