import { getSettings, saveSettings } from "@/lib/tauri-api";

export const TERMINAL_FONT_SIZE_KEY = "terminal-font-size";
export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const LEGACY_TERMINAL_FONT_SIZE = 11;
export const MIN_TERMINAL_FONT_SIZE = 9;
export const MAX_TERMINAL_FONT_SIZE = 16;

export function clampTerminalFontSize(value: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, value));
}

export function normalizeTerminalFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }

  if (value === LEGACY_TERMINAL_FONT_SIZE) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }

  return clampTerminalFontSize(value);
}

export function isTerminalFontZoomShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;

  return (
    event.key === "=" ||
    event.key === "+" ||
    event.key === "-" ||
    event.key === "0" ||
    event.code === "NumpadAdd" ||
    event.code === "NumpadSubtract" ||
    event.code === "Numpad0"
  );
}

export async function loadTerminalPreferences(): Promise<{
  settings: Record<string, unknown>;
  terminalFontSize: number;
}> {
  const settings = await getSettings();
  return {
    settings,
    terminalFontSize: normalizeTerminalFontSize(settings[TERMINAL_FONT_SIZE_KEY]),
  };
}

export async function persistTerminalFontSize(
  settings: Record<string, unknown> | null,
  terminalFontSize: number,
): Promise<Record<string, unknown>> {
  const nextSettings = settings ? { ...settings } : {};
  nextSettings[TERMINAL_FONT_SIZE_KEY] = terminalFontSize;
  await saveSettings(nextSettings);
  return nextSettings;
}
