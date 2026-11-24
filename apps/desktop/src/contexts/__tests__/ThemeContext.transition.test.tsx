import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSettings, saveSettings } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock("@/lib/tauri-api", () => ({ getSettings, saveSettings }));
const nativeWindow = vi.hoisted(() => ({ setTheme: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: nativeWindow.setTheme }) }));

import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";
import { APP_THEME_SETTINGS_KEY } from "@/lib/theme-settings";

/*
 * A theme switch crossfades through the View Transitions API (Theme 08/15). Only a change the user
 * makes, or macOS flipping appearance while the preference is System, may animate; the first paint
 * and the settings.json restore must not. These tests observe <html data-theme-type> and a fake
 * document.startViewTransition, so they hold whichever way the provider is wired inside.
 */

type MediaListener = () => void;

function installMatchMedia({ systemDark, reducedMotion }: { systemDark: boolean; reducedMotion: boolean }) {
  const listeners = new Set<MediaListener>();
  const state = { systemDark };
  window.matchMedia = ((query: string) => ({
    get matches() {
      if (query.includes("prefers-color-scheme: dark")) return state.systemDark;
      if (query.includes("prefers-reduced-motion: reduce")) return reducedMotion;
      return false;
    },
    media: query,
    addEventListener: (_: string, fn: MediaListener) => listeners.add(fn),
    removeEventListener: (_: string, fn: MediaListener) => listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  return {
    flipSystem(dark: boolean) {
      if (state.systemDark === dark) return;
      state.systemDark = dark;
      listeners.forEach((fn) => fn());
    },
  };
}

/** Records each transition and the theme type visible before and after its update callback ran. */
function installViewTransitions() {
  const calls: Array<{ before: string | null; after: string | null }> = [];
  (document as unknown as { startViewTransition: unknown }).startViewTransition = (update: () => void) => {
    const before = document.documentElement.getAttribute("data-theme-type");
    update();
    calls.push({ before, after: document.documentElement.getAttribute("data-theme-type") });
    const done = Promise.resolve();
    return { finished: done, ready: done, updateCallbackDone: done, skipTransition: () => {} };
  };
  return calls;
}

/** Like the browser: each update callback runs later, when `flush` is called, not inside startViewTransition. */
function installDeferredViewTransitions() {
  const pending: Array<() => void> = [];
  (document as unknown as { startViewTransition: unknown }).startViewTransition = (update: () => void) => {
    pending.push(update);
    const done = Promise.resolve();
    return { finished: done, ready: done, updateCallbackDone: done, skipTransition: () => {} };
  };
  return { flush: () => pending.splice(0).forEach((update) => update()) };
}

let api: ReturnType<typeof useTheme>;
function Probe() {
  api = useTheme();
  return null;
}

async function mount() {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  // let the settings.json restore settle
  await act(async () => {});
}

function themeType() {
  return document.documentElement.getAttribute("data-theme-type");
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme-preference");
  document.documentElement.removeAttribute("data-theme-type");
  getSettings.mockResolvedValue({});
  saveSettings.mockResolvedValue(undefined);
});

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.useRealTimers();
});

describe("ThemeProvider theme transition", () => {
  it("applies a user's theme change inside a view transition", async () => {
    installMatchMedia({ systemDark: true, reducedMotion: false });
    const calls = installViewTransitions();
    await mount();
    expect(themeType()).toBe("dark");

    act(() => api.setThemePreference("light"));

    expect(calls).toEqual([{ before: "dark", after: "light" }]);
    expect(themeType()).toBe("light");
  });

  it("switches instantly when the user asks for reduced motion", async () => {
    installMatchMedia({ systemDark: true, reducedMotion: true });
    const calls = installViewTransitions();
    await mount();

    act(() => api.setThemePreference("light"));

    expect(calls).toEqual([]);
    expect(themeType()).toBe("light");
  });

  it("switches instantly where the View Transitions API is missing", async () => {
    installMatchMedia({ systemDark: true, reducedMotion: false });
    await mount();

    act(() => api.setThemePreference("light"));

    expect(themeType()).toBe("light");
  });

  it("does not animate the first paint or the settings.json restore", async () => {
    installMatchMedia({ systemDark: true, reducedMotion: false });
    const calls = installViewTransitions();
    getSettings.mockResolvedValue({ [APP_THEME_SETTINGS_KEY]: "light" });

    await mount();

    expect(themeType()).toBe("light");
    expect(calls).toEqual([]);
  });

  it("does not animate re-selecting the current preference", async () => {
    installMatchMedia({ systemDark: true, reducedMotion: false });
    const calls = installViewTransitions();
    await mount();

    act(() => api.setThemePreference("system"));

    expect(calls).toEqual([]);
  });

  it("ends on the last choice when the user switches again before the first crossfade has applied", async () => {
    installMatchMedia({ systemDark: true, reducedMotion: false });
    const transitions = installDeferredViewTransitions();
    await mount();

    act(() => api.setThemePreference("dark"));
    act(() => api.setThemePreference("system"));
    act(() => transitions.flush());

    expect(api.themePreference).toBe("system");
    expect(document.documentElement.getAttribute("data-theme-preference")).toBe("system");
    expect(localStorage.getItem("app-theme-id")).toBe("system");
  });

  it("animates a macOS appearance flip while the preference is System", async () => {
    const media = installMatchMedia({ systemDark: true, reducedMotion: false });
    const calls = installViewTransitions();
    await mount();

    act(() => media.flipSystem(false));

    expect(calls).toEqual([{ before: "dark", after: "light" }]);
  });

  it("returns to System in one crossfade to the real OS mode after the native window was pinned", async () => {
    // Worst case for the pin: NSApp's appearance leaks into the webview, so prefers-color-scheme
    // reports the pinned mode until the window is handed back to macOS (setTheme(null)).
    const osDark = false;
    const media = installMatchMedia({ systemDark: osDark, reducedMotion: false });
    nativeWindow.setTheme.mockReset().mockImplementation((theme: "dark" | "light" | null) =>
      Promise.resolve().then(() => media.flipSystem(theme === null ? osDark : theme === "dark")),
    );
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const calls = installViewTransitions();
    await mount();
    await act(async () => api.setThemePreference("dark"));
    expect(themeType()).toBe("dark");
    calls.length = 0;

    await act(async () => api.setThemePreference("system"));

    expect(calls).toEqual([{ before: "dark", after: "light" }]);
    expect(themeType()).toBe("light");
  });

  it("picks up a macOS flip made while a fixed theme was chosen once the user returns to System", async () => {
    const media = installMatchMedia({ systemDark: true, reducedMotion: false });
    installViewTransitions();
    await mount();
    act(() => api.setThemePreference("light"));
    act(() => media.flipSystem(false));
    act(() => media.flipSystem(true));
    act(() => media.flipSystem(false));

    await act(async () => api.setThemePreference("system"));

    expect(themeType()).toBe("light");
  });

  it("ignores a macOS appearance flip while a fixed theme is chosen", async () => {
    const media = installMatchMedia({ systemDark: true, reducedMotion: false });
    const calls = installViewTransitions();
    await mount();
    act(() => api.setThemePreference("dark"));
    calls.length = 0;

    act(() => media.flipSystem(false));

    expect(calls).toEqual([]);
    expect(themeType()).toBe("dark");
  });
});
