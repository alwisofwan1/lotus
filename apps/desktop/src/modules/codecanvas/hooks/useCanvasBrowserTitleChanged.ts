"use client";

import { useCanvasBrowserStringChangedEvent } from "./useCanvasBrowserStringChangedEvent";

export const CANVAS_BROWSER_TITLE_CHANGED_EVENT = "canvas://browser-title-changed";

interface UseCanvasBrowserTitleChangedOptions {
  nativeBrowserId: string;
  onTitleChanged: (title: string) => void;
}

export function useCanvasBrowserTitleChanged({
  nativeBrowserId,
  onTitleChanged,
}: UseCanvasBrowserTitleChangedOptions): void {
  useCanvasBrowserStringChangedEvent({
    eventName: CANVAS_BROWSER_TITLE_CHANGED_EVENT,
    nativeBrowserId,
    field: "title",
    onChanged: onTitleChanged,
  });
}
