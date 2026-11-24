"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings } from "@/lib/tauri-api";
import { LOTUS_SETTINGS_CHANGED_EVENT, readLotusSettingsChangedDetail } from "@/modules/settings/services/settings-events";
import {
  readEditorPreferences,
  saveEditorPreferences,
  type EditorPreferenceChange,
  type EditorPreferences,
} from "@/modules/codespace/services/editor-preferences";

/**
 * The Editor pane's preferences, kept in step with Settings and with changes from other panes.
 * `update` shows a change at once, then saves it; other panes follow once it is saved.
 */
export function useEditorPreferences(): [EditorPreferences, (change: EditorPreferenceChange) => void] {
  const [preferences, setPreferences] = useState<EditorPreferences>(() => readEditorPreferences(null));
  // A change made before the first read comes back is newer than what that read says.
  const changedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Unreadable settings: the defaults stand. Inside `then` so a throwing call is caught too.
    Promise.resolve()
      .then(() => getSettings())
      .then((data) => {
        if (!cancelled && !changedRef.current) setPreferences(readEditorPreferences(data as Record<string, unknown>));
      })
      .catch(() => {});

    const handler = (event: Event) => {
      const detail = readLotusSettingsChangedDetail(event);
      if (detail) setPreferences(readEditorPreferences(detail.settings));
    };
    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
    };
  }, []);

  const update = useCallback((change: EditorPreferenceChange) => {
    changedRef.current = true;
    setPreferences((current) => ({ ...current, ...change }));
    // Not saved (no settings file here): the change stays for this session.
    void saveEditorPreferences(change).catch(() => {});
  }, []);

  return [preferences, update];
}
