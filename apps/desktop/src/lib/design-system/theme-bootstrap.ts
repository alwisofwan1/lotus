import { DESIGN_THEMES } from "@/lib/design-system/themes";
import {
  DEFAULT_THEME_PREFERENCE,
  getDesignThemeCssVars,
  RETIRED_THEME_MODES,
} from "@/lib/design-system/resolve-theme";

/**
 * Inline script that applies the stored theme before React hydrates, so the first paint is already
 * in the right mode. It cannot import, so it carries the theme payload and the retired-id table as
 * JSON — the same table `normalizeThemePreference` reads.
 */
export function buildThemeBootstrapScript(): string {
  const themePayload = Object.fromEntries(
    Object.entries(DESIGN_THEMES).map(([mode, theme]) => [
      mode,
      {
        id: theme.id,
        type: theme.type,
        cssVars: getDesignThemeCssVars(theme),
      },
    ]),
  );

  return `
    (() => {
      try {
        const themes = ${JSON.stringify(themePayload)};
        const retiredThemes = ${JSON.stringify(RETIRED_THEME_MODES)};
        const root = document.documentElement;
        const stored = window.localStorage.getItem("app-theme-id");
        const normalize = (value) => {
          if (value === "system" || value === "dark" || value === "light") return value;
          if (typeof value === "string" && Object.prototype.hasOwnProperty.call(retiredThemes, value)) {
            return retiredThemes[value];
          }
          return ${JSON.stringify(DEFAULT_THEME_PREFERENCE)};
        };
        const preference = normalize(stored);
        const systemMode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        const resolvedMode = preference === "system" ? systemMode : preference;
        const theme = themes[resolvedMode] ?? themes.dark;
        if (!theme) return;
        root.setAttribute("data-theme-id", theme.id);
        root.setAttribute("data-theme-type", theme.type);
        root.setAttribute("data-theme-preference", preference);
        // The window is transparent with a native vibrancy material behind it on macOS only
        // (tauri.conf.json windowEffects), so only there may the page let it show through.
        if ("__TAURI_INTERNALS__" in window && /Mac/.test(navigator.platform)) {
          root.setAttribute("data-window-glass", "true");
        }
        for (const [key, value] of Object.entries(theme.cssVars)) {
          root.style.setProperty(key, value);
        }
      } catch {}
    })();
  `;
}
