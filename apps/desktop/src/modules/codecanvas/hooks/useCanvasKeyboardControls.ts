"use client";
import { useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { shouldPreventCanvasDeleteNavigation } from "../services/canvas-keyboard-guard";

// ⌘, is not handled here: it opens Lotus Settings from every mode (LotusSettingsProvider).
export function useCanvasKeyboardControls() {
  useEffect(() => {
    const onDeleteNavigationKey = (event: KeyboardEvent) => {
      if (shouldPreventCanvasDeleteNavigation(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onDeleteNavigationKey, { capture: true });
    return () => window.removeEventListener("keydown", onDeleteNavigationKey, { capture: true });
  }, []);

  return useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (shouldPreventCanvasDeleteNavigation(event.nativeEvent)) event.preventDefault();
  }, []);
}
