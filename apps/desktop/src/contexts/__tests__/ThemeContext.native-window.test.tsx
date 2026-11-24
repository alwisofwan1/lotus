import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "../ThemeContext";
import type { ThemePreference } from "@/lib/design-system";

const windowMock = vi.hoisted(() => ({ setTheme: vi.fn() }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme: windowMock.setTheme }),
}));

vi.mock("@/lib/tauri-api", () => ({
  getSettings: () => Promise.reject(new Error("no settings in test")),
  saveSettings: () => Promise.resolve(),
}));

let pick: (preference: ThemePreference) => void = () => {};

function Picker() {
  pick = useTheme().setThemePreference;
  return null;
}

function stubMatchMedia(dark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: dark, addEventListener: () => {}, removeEventListener: () => {} }),
  });
}

describe("ThemeProvider native window theme", () => {
  beforeEach(() => {
    windowMock.setTheme.mockReset().mockResolvedValue(undefined);
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme-preference");
    stubMatchMedia(true);
  });

  afterEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  function markTauri() {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  }

  it("pins the native window to Light when the user picks Light on a dark macOS", async () => {
    markTauri();
    window.localStorage.setItem("app-theme-id", "light");
    render(<ThemeProvider><Picker /></ThemeProvider>);

    await waitFor(() => expect(windowMock.setTheme).toHaveBeenLastCalledWith("light"));
  });

  it("hands the native window back to macOS (null) when the user picks System", async () => {
    markTauri();
    window.localStorage.setItem("app-theme-id", "dark");
    render(<ThemeProvider><Picker /></ThemeProvider>);
    await waitFor(() => expect(windowMock.setTheme).toHaveBeenLastCalledWith("dark"));

    act(() => pick("system"));

    await waitFor(() => expect(windowMock.setTheme).toHaveBeenLastCalledWith(null));
  });

  it("does not touch the native window in a plain browser", async () => {
    window.localStorage.setItem("app-theme-id", "light");
    render(<ThemeProvider><Picker /></ThemeProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(windowMock.setTheme).not.toHaveBeenCalled();
  });
});
