export const LOTUS_SETTINGS_CHANGED_EVENT = "lotus:settings-changed";

export interface LotusSettingsChangedDetail {
  settings: Record<string, unknown>;
}

export function emitLotusSettingsChanged(settings: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<LotusSettingsChangedDetail>(
    LOTUS_SETTINGS_CHANGED_EVENT,
    { detail: { settings } },
  ));
}

export function readLotusSettingsChangedDetail(event: Event): LotusSettingsChangedDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const settings = (detail as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  return { settings: settings as Record<string, unknown> };
}
