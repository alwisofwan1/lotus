import {
  DEFAULT_THEME_PREFERENCE,
  normalizeThemePreference,
  type ThemePreference,
} from "@/lib/design-system";

export const APP_THEME_SETTINGS_KEY = "orchids_theme";
export const LEGACY_APP_THEME_SETTINGS_KEY = "theme";

function readLegacyAppTheme(value: unknown): ThemePreference | null {
  if (value === "dark" || value === "light" || value === "system") return null;
  return normalizeThemePreference(value);
}

export function readAppThemeIdFromSettings(
  settings: Record<string, unknown> | null | undefined,
): ThemePreference | undefined {
  const current = settings?.[APP_THEME_SETTINGS_KEY];
  const normalizedCurrent = normalizeThemePreference(current);
  if (normalizedCurrent) {
    return normalizedCurrent;
  }

  const legacy = settings?.[LEGACY_APP_THEME_SETTINGS_KEY];
  const normalizedLegacy = readLegacyAppTheme(legacy);
  if (normalizedLegacy) {
    return normalizedLegacy;
  }

  return undefined;
}

export function withAppThemeSetting(
  settings: Record<string, unknown> | null | undefined,
  themeId: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(settings ?? {}) };
  next[APP_THEME_SETTINGS_KEY] = normalizeThemePreference(themeId) ?? DEFAULT_THEME_PREFERENCE;

  const legacy = next[LEGACY_APP_THEME_SETTINGS_KEY];
  if (readLegacyAppTheme(legacy)) {
    delete next[LEGACY_APP_THEME_SETTINGS_KEY];
  }

  return next;
}
