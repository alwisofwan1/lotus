"use client";

import { useEffect, useState } from "react";
import { getSettings } from "@/lib/tauri-api";
import {
  LOTUS_SETTINGS_CHANGED_EVENT,
  readLotusSettingsChangedDetail,
} from "@/modules/settings/services/settings-events";

/**
 * Resolve the `codespace.autoPaneTitles` flag from `~/.claude/settings.json`.
 * Defaults to ON when unset (per Q11-D in the slice 5 grilling: settings
 * toggle global, default ON, no first-time consent dialog).
 *
 * Lives on its own hook so each terminal pane can react to toggle flips
 * without an app restart — both the initial load and the in-memory
 * `lotus:settings-changed` event keep the flag in sync.
 */
export function useAutoPaneTitlesEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    void getSettings()
      .then((data) => {
        if (cancelled) return;
        const flag = readAutoPaneTitlesFlag(data as Record<string, unknown>);
        setEnabled(flag);
      })
      .catch(() => {
        // Settings file is missing / unreadable → default ON, ride it out.
      });

    const handler = (event: Event) => {
      const detail = readLotusSettingsChangedDetail(event);
      if (!detail) return;
      setEnabled(readAutoPaneTitlesFlag(detail.settings));
    };
    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);

    return () => {
      cancelled = true;
      window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
    };
  }, []);

  return enabled;
}

function readAutoPaneTitlesFlag(raw: Record<string, unknown> | null | undefined): boolean {
  if (!raw || typeof raw !== "object") return true;
  const codespace = (raw as { codespace?: unknown }).codespace;
  if (!codespace || typeof codespace !== "object") return true;
  const flag = (codespace as { autoPaneTitles?: unknown }).autoPaneTitles;
  if (typeof flag !== "boolean") return true;
  return flag;
}
