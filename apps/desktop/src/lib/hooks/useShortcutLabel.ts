"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ariaKeyShortcuts, formatShortcut } from "@/lib/hotkeys/format-shortcut";
import { readPlatformString } from "@/lib/platform";

const subscribeNever = () => () => {};
/**
 * Prerender has no navigator, so the server writes the labels as they are authored — macOS
 * glyphs. Hydrating with the same answer keeps the first client render identical to that HTML;
 * the real platform takes over on the render after, which on macOS changes nothing at all.
 */
const serverPlatform = () => "MacIntel";

/** The platform string shortcut labels are written for, safe to read during render. */
export function useShortcutPlatform(): string {
  return useSyncExternalStore(subscribeNever, readPlatformString, serverPlatform);
}

/** `formatShortcut` bound to this machine, hydration-safe: `"⇧⌘G"` → `"Ctrl+Shift+G"` off macOS. */
export function useFormatShortcut(): (label: string) => string {
  const platform = useShortcutPlatform();
  return useCallback((label: string) => formatShortcut(label, platform), [platform]);
}

/** `ariaKeyShortcuts` bound to this machine, hydration-safe: `"⌘L"` → `"Meta+L"` / `"Control+L"`. */
export function useAriaKeyShortcuts(): (label: string) => string {
  const platform = useShortcutPlatform();
  return useCallback((label: string) => ariaKeyShortcuts(label, platform), [platform]);
}
