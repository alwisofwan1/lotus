"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  LAYOUT_STORAGE_KEY,
  parseLayoutPreferences,
  serializeLayoutPreferences,
  type ShellLayoutPreferences,
} from "@/modules/workspace-shell/services/layout-preferences";

/**
 * The stored layout is read as an external store rather than copied into state by an effect.
 *
 * That is what makes it hydration-safe: `useSyncExternalStore` renders the SERVER snapshot
 * while React hydrates and only then switches to the browser one, so the server's HTML and the
 * client's first render agree even though only one of them can see `localStorage`.
 *
 * `storage` events cover other windows; same-window writes notify the local listeners directly,
 * because the browser deliberately does not fire `storage` at the tab that wrote.
 */

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY);
  } catch {
    // A blocked or full store is not a reason to refuse to open.
    return null;
  }
}

/** Nothing is stored as far as the server is concerned, so it renders the default layout. */
function readServerRaw(): string | null {
  return null;
}

function writeRaw(preferences: ShellLayoutPreferences): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, serializeLayoutPreferences(preferences));
  } catch {
    // Same: a layout that cannot be written is still a layout that works this session.
  }
  emit();
}

export function useShellLayout() {
  const raw = useSyncExternalStore(subscribe, readRaw, readServerRaw);
  const layout = useMemo(() => parseLayoutPreferences(raw), [raw]);

  const update = useCallback(
    (patch: Partial<ShellLayoutPreferences>) => {
      writeRaw({ ...parseLayoutPreferences(readRaw()), ...patch });
    },
    [],
  );

  return { layout, update };
}
