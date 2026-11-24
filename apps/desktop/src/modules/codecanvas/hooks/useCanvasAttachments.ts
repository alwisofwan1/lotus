"use client";
import { useSyncExternalStore } from "react";
import { canvasAttachmentStore } from "../services/canvas-attachment-store";
import type { CanvasImageRef } from "../services/canvas-intake";

/** Live attachments held by one Canvas Node (session store), via the external-store seam. */
export function useCanvasAttachments(nodeId: string): CanvasImageRef[] {
  return useSyncExternalStore(
    (onChange) => canvasAttachmentStore.subscribe(nodeId, onChange),
    () => canvasAttachmentStore.list(nodeId),
  );
}
