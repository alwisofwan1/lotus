"use client";

import { useCallback, useState } from "react";

import { DEFAULT_LAYOUT, LAYOUT_BOUNDS } from "@/modules/workspace-shell/services/layout-preferences";

/**
 * The two seam widths of the Automations surface, wherever it is mounted.
 *
 * A host with its own stored layout (the workspace shell, for Code and Chat) passes it in and
 * keeps the widths with the rest of its seams. A host without one (Canvas, a preview) gets them
 * kept in this browser's storage under one key, so a drag survives a restart there too. Storage
 * can be missing or refuse (a private window, a test); the widths then live for this mount only.
 */

export interface AutomationWidths {
  automationNavWidth: number;
  automationPaneWidth: number;
}

export const AUTOMATION_LAYOUT_KEY = "lotus.automation.layout";

const DEFAULTS: AutomationWidths = {
  automationNavWidth: DEFAULT_LAYOUT.automationNavWidth,
  automationPaneWidth: DEFAULT_LAYOUT.automationPaneWidth,
};

function within(value: unknown, fallback: number, bounds: { min: number; max: number }): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(bounds.max, Math.max(bounds.min, value))) : fallback;
}

/** Stored widths, each checked: a bad or missing value falls back to its default, never to NaN. */
export function readStoredWidths(): AutomationWidths {
  try {
    const raw = globalThis.localStorage?.getItem(AUTOMATION_LAYOUT_KEY);
    if (!raw) return DEFAULTS;
    const value = JSON.parse(raw) as Partial<Record<keyof AutomationWidths, unknown>>;
    return {
      automationNavWidth: within(value?.automationNavWidth, DEFAULTS.automationNavWidth, LAYOUT_BOUNDS.automationNavWidth),
      automationPaneWidth: within(value?.automationPaneWidth, DEFAULTS.automationPaneWidth, LAYOUT_BOUNDS.automationPaneWidth),
    };
  } catch {
    return DEFAULTS;
  }
}

function storeWidths(widths: AutomationWidths) {
  try {
    globalThis.localStorage?.setItem(AUTOMATION_LAYOUT_KEY, JSON.stringify(widths));
  } catch {
    // Storage refused: the widths still apply for this mount.
  }
}

export function useAutomationLayout(
  hosted?: AutomationWidths,
  onHostedChange?: (patch: Partial<AutomationWidths>) => void,
): [AutomationWidths, (patch: Partial<AutomationWidths>) => void] {
  const [own, setOwn] = useState<AutomationWidths>(() => (hosted ? DEFAULTS : readStoredWidths()));
  const setOwnWidths = useCallback((patch: Partial<AutomationWidths>) => {
    setOwn((prev) => {
      const next = { ...prev, ...patch };
      storeWidths(next);
      return next;
    });
  }, []);
  return hosted && onHostedChange ? [hosted, onHostedChange] : [own, setOwnWidths];
}
