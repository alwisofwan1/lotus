"use client";
import { useSyncExternalStore } from "react";
import {
  getCanvasBrowserActivity,
  subscribeCanvasBrowserActivity,
} from "../services/canvas-browser-activity-store";

/** Whether an agent is currently driving the browser paired with `terminalId` (snapshot/click/…). */
export function useCanvasBrowserActivity(terminalId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribeCanvasBrowserActivity,
    () => (terminalId ? getCanvasBrowserActivity(terminalId) : false),
    () => false,
  );
}
