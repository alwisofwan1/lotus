"use client";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  loadTerminalPreferences,
  normalizeTerminalFontSize,
  persistTerminalFontSize,
  TERMINAL_FONT_SIZE_KEY,
} from "@/modules/codespace/services/terminal-settings";
import {
  LOTUS_SETTINGS_CHANGED_EVENT,
  readLotusSettingsChangedDetail,
} from "@/modules/settings/services/settings-events";

export function useTerminalPreferences() {
  const [terminalFontSize, setTerminalFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
  const terminalFontSizeRef = useRef(DEFAULT_TERMINAL_FONT_SIZE);
  const settingsRef = useRef<Record<string, unknown> | null>(null);
  const loadedRef = useRef(false);
  const skipNextPersistRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    loadTerminalPreferences()
      .then(({ settings, terminalFontSize: loadedTerminalFontSize }) => {
        settingsRef.current = settings;
        if (cancelled) return;
        loadedRef.current = true;
        terminalFontSizeRef.current = loadedTerminalFontSize;
        setTerminalFontSize(loadedTerminalFontSize);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    terminalFontSizeRef.current = terminalFontSize;
    if (!loadedRef.current) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      persistTerminalFontSize(settingsRef.current, terminalFontSize)
        .then((nextSettings) => {
          settingsRef.current = nextSettings;
        })
        .catch(() => {});
    }, 120);

    return () => window.clearTimeout(timer);
  }, [terminalFontSize]);

  useEffect(() => {
    const handleSettingsChanged = (event: Event) => {
      const detail = readLotusSettingsChangedDetail(event);
      if (!detail) return;

      settingsRef.current = detail.settings;
      const nextTerminalFontSize = normalizeTerminalFontSize(detail.settings[TERMINAL_FONT_SIZE_KEY]);
      if (nextTerminalFontSize === terminalFontSizeRef.current) return;

      skipNextPersistRef.current = true;
      terminalFontSizeRef.current = nextTerminalFontSize;
      setTerminalFontSize(nextTerminalFontSize);
    };

    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    return () => window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
  }, []);

  return {
    terminalFontSize,
    setTerminalFontSize,
  };
}
