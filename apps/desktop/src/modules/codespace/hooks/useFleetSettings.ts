"use client";

import { useEffect, useRef, useState } from "react";
import { getSettings, isTauri } from "@/lib/tauri-api";
import type { ClaudeSettings } from "@/modules/settings/types";
import {
  LOTUS_SETTINGS_CHANGED_EVENT,
  readLotusSettingsChangedDetail,
} from "@/modules/settings/services/settings-events";
import {
  DEFAULT_FLEET_SETTINGS,
  resolveFleetSettings,
  type FleetSettings,
} from "@/modules/codespace/services/bridge/fleet-settings";

export type FleetSettingsReader = {
  /** The latest resolved values. */
  current: FleetSettings;
  /** Stable getter — safe to store once per dispatcher. */
  read: () => FleetSettings;
};

/**
 * Reads the fleet slice of `~/.claude/settings.json`, and re-reads it when the settings editor
 * saves (`lotus:settings-changed`).
 *
 * Replaces `useBridgeSettings`, which resolved the whole Bridge tree — persona, context, planner
 * CLIs, logging — for a feature that no longer exists. The reader kept its shape (`current` +
 * a stable `read()`), because the one caller stores the getter once and calls it from a timer.
 *
 * Safe outside Tauri: returns defaults immediately.
 */
export function useFleetSettings(): FleetSettingsReader {
  const [resolved, setResolved] = useState<FleetSettings>(() => ({ ...DEFAULT_FLEET_SETTINGS }));
  const resolvedRef = useRef(resolved);
  useEffect(() => {
    resolvedRef.current = resolved;
  }, [resolved]);

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) return;
    getSettings()
      .then((data) => {
        if (cancelled) return;
        setResolved(resolveFleetSettings(data as ClaudeSettings));
      })
      .catch(() => {
        /* fall back to the defaults already in state */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = readLotusSettingsChangedDetail(event);
      if (!detail) return;
      setResolved(resolveFleetSettings(detail.settings as ClaudeSettings));
    };
    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
  }, []);

  return {
    current: resolved,
    read: () => resolvedRef.current,
  };
}
