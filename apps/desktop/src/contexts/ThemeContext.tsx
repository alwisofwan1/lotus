"use client";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  DEFAULT_THEME_PREFERENCE,
  getDesignTheme,
  getDesignThemeCssVars,
  normalizeThemePreference,
  resolveThemeMode,
} from "@/lib/design-system";
import type { AppTheme, ResolvedThemeMode, ThemeId, ThemePreference } from "@/lib/design-system";
import { runThemeTransition, whenThemeTransitionSettles, type ThemeRevealOrigin } from "@/lib/design-system/theme-transition";
import { readAppThemeIdFromSettings, withAppThemeSetting } from "@/lib/theme-settings";
import { isTauri } from "@/lib/tauri/runtime";
import { installUiZoom } from "@/lib/ui-zoom";

interface ThemeContextValue {
  theme: AppTheme;
  themeId: string;
  themePreference: ThemePreference;
  resolvedThemeMode: ResolvedThemeMode;
  /** macOS's own appearance, whatever the preference. Last known value while Dark or Light is pinned. */
  systemThemeMode: ResolvedThemeMode;
  setThemeId: (id: string) => void;
  /** `origin` is where the pressed control sits: the new theme grows out of it. */
  setThemePreference: (preference: ThemePreference, origin?: ThemeRevealOrigin) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: getDesignTheme("dark"),
  themeId: "dark",
  themePreference: DEFAULT_THEME_PREFERENCE,
  resolvedThemeMode: "dark",
  systemThemeMode: "dark",
  setThemeId: () => {},
  setThemePreference: () => {},
});

function getSystemThemeMode(): ResolvedThemeMode {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Pin the native chrome (traffic lights, title bar overlay, window background) to the app theme.
// On macOS this sets NSApp.appearance, so it is app-wide; null hands control back to macOS.
// System passes null, not the resolved mode: the webview inherits NSApp's appearance, so pinning
// it would likely make prefers-color-scheme report the pinned mode instead of the real OS one.
// Resolves once the native call has landed (or failed).
function applyNativeWindowTheme(preference: ThemePreference): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  const theme = preference === "system" ? null : preference;
  return import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
    .catch(() => undefined);
}

function resolveInitialThemePreference(): ThemePreference {
  if (typeof document !== "undefined") {
    const bootstrappedPreference = normalizeThemePreference(
      document.documentElement.getAttribute("data-theme-preference"),
    );
    if (bootstrappedPreference) return bootstrappedPreference;
  }

  if (typeof window !== "undefined") {
    const storedThemeId = window.localStorage.getItem("app-theme-id");
    const preference = normalizeThemePreference(storedThemeId);
    if (preference) return preference;
  }

  return DEFAULT_THEME_PREFERENCE;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(resolveInitialThemePreference);
  const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(getSystemThemeMode);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The preference last asked for. A crossfade applies its change a frame later, so the state can
  // still hold the previous choice when the user picks again; compare and apply against this instead.
  const requestedPreferenceRef = useRef(themePreference);
  const restorePreference = (preference: ThemePreference) => {
    requestedPreferenceRef.current = preference;
    setThemePreferenceState(preference);
  };

  // Interface size (page zoom) and its ⌘+ / ⌘− / ⌘0 keys, in every window.
  useEffect(() => installUiZoom(), []);

  // Load persisted theme: settings.json first, fall back to localStorage
  useEffect(() => {
    async function loadTheme() {
      try {
        const { getSettings, saveSettings } = await import("@/lib/tauri-api");
        const settings = await getSettings();
        const savedPreference = readAppThemeIdFromSettings(settings);
        if (savedPreference) {
          restorePreference(savedPreference);
          localStorage.setItem("app-theme-id", savedPreference);
          const migrated = withAppThemeSetting(settings, savedPreference);
          if (JSON.stringify(migrated) !== JSON.stringify(settings)) {
            void saveSettings(migrated).catch(() => undefined);
          }
          return;
        }
      } catch { /* fall through to localStorage */ }
      const saved = window.localStorage.getItem("app-theme-id");
      const preference = normalizeThemePreference(saved);
      if (preference) restorePreference(preference);
    }
    loadTheme();
  }, []);

  const themePreferenceRef = useRef(themePreference);
  themePreferenceRef.current = themePreference;
  const systemThemeModeRef = useRef(systemThemeMode);
  systemThemeModeRef.current = systemThemeMode;

  // While Dark or Light is pinned on the native window, prefers-color-scheme may report the pinned
  // mode rather than macOS's (unverified, see applyNativeWindowTheme), so it is only read under
  // System. A macOS appearance flip crossfades only when it actually changes what is on screen.
  const syncSystemThemeMode = () => {
    if (themePreferenceRef.current !== "system") return;
    const next = getSystemThemeMode();
    if (next === systemThemeModeRef.current) return;
    runThemeTransition(() => flushSync(() => setSystemThemeMode(next)));
  };

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemThemeMode(getSystemThemeMode());
    query.addEventListener("change", syncSystemThemeMode);
    return () => query.removeEventListener("change", syncSystemThemeMode);
  }, []);

  const resolvedThemeMode = resolveThemeMode(themePreference, systemThemeMode);
  const themeId: ThemeId = themePreference === "system" ? resolvedThemeMode : themePreference;
  const theme = getDesignTheme(themeId);

  // Apply CSS variables to :root whenever the theme changes. A layout effect, so a flushSync'd switch
  // has fully landed before runThemeTransition takes the new snapshot.
  useLayoutEffect(() => {
    const r = document.documentElement;
    const cssVars = getDesignThemeCssVars(theme);

    for (const [key, value] of Object.entries(cssVars)) {
      r.style.setProperty(key, value);
    }

    r.setAttribute("data-theme-id", theme.id);
    r.setAttribute("data-theme-type", theme.type);
    r.setAttribute("data-theme-preference", themePreference);
  }, [theme, themePreference]);

  // Back on System, macOS's own appearance is readable again once the window is handed back to it.
  // The native call waits for the switch's animation: macOS repaints the whole webview when the app
  // appearance changes, which held the new theme back by ~0.3–1s and stuttered the reveal. A newer pick
  // cancels a waiting one, so only the last choice reaches the window.
  useEffect(() => {
    let cancelled = false;
    void whenThemeTransitionSettles().then(() => {
      if (cancelled) return;
      return applyNativeWindowTheme(themePreference).then(syncSystemThemeMode);
    });
    return () => {
      cancelled = true;
    };
  }, [themePreference]);

  const setThemePreference = (preference: ThemePreference, origin?: ThemeRevealOrigin) => {
    if (preference !== requestedPreferenceRef.current) {
      requestedPreferenceRef.current = preference;
      runThemeTransition(
        () =>
          flushSync(() => {
            const next = requestedPreferenceRef.current;
            // Nothing is pinned outside Tauri, so macOS's mode can be read now and the switch is one transition.
            if (next === "system" && !isTauri()) setSystemThemeMode(getSystemThemeMode());
            setThemePreferenceState(next);
          }),
        origin,
      );
    }
    localStorage.setItem("app-theme-id", preference);
    // Debounce write to avoid spamming if user cycles through themes quickly
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { getSettings, saveSettings } = await import("@/lib/tauri-api");
        const existing = await getSettings();
        await saveSettings(withAppThemeSetting(existing, preference));
      } catch { /* non-critical, localStorage already updated */ }
    }, 500);
  };

  const setThemeId = (id: string) => {
    const preference = normalizeThemePreference(id);
    if (!preference) return;
    setThemePreference(preference);
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        themeId,
        themePreference,
        resolvedThemeMode,
        systemThemeMode,
        setThemeId,
        setThemePreference,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
