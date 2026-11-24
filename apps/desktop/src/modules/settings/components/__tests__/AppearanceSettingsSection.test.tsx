import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { DESIGN_THEMES, getDesignThemeCssVars } from "@/lib/design-system";
import { AppearanceSettingsSection } from "../AppearanceSettingsSection";

vi.mock("@/lib/tauri-api", () => ({
  getSettings: () => Promise.reject(new Error("no settings in test")),
  saveSettings: () => Promise.resolve(),
}));

// A macOS appearance the test can flip, like System Settings → Appearance.
const macos = { dark: true, listeners: new Set<() => void>() };

function stubMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() { return macos.dark; },
      addEventListener: (_: string, listener: () => void) => macos.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => macos.listeners.delete(listener),
    }),
  });
}

function flipMacos(dark: boolean) {
  macos.dark = dark;
  act(() => macos.listeners.forEach((listener) => listener()));
}

function renderSection() {
  return render(<ThemeProvider><AppearanceSettingsSection /></ThemeProvider>);
}

describe("AppearanceSettingsSection", () => {
  beforeEach(() => {
    macos.dark = true;
    macos.listeners.clear();
    stubMatchMedia();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme-preference");
  });

  it("says which mode macOS is in, and follows it live", () => {
    renderSection();
    expect(screen.getByText(/Choose how Lotus looks\. System follows your macOS setting — currently/))
      .toHaveTextContent("Choose how Lotus looks. System follows your macOS setting — currently Dark.");

    flipMacos(false);

    expect(screen.getByText(/System follows your macOS setting/)).toHaveTextContent("currently Light.");
  });

  it("does not claim a macOS mode while Dark or Light is pinned", () => {
    window.localStorage.setItem("app-theme-id", "light");
    document.documentElement.setAttribute("data-theme-preference", "light");
    renderSection();
    expect(screen.getByText(/System follows your macOS setting/).textContent).not.toMatch(/currently/);
  });

  it("promises no crossfade, which reduced motion and older WebKit skip", () => {
    renderSection();
    expect(document.body.textContent).not.toMatch(/crossfade/i);
  });

  function previewShells(card: HTMLElement) {
    return [...card.querySelectorAll<HTMLElement>("[data-preview-mode]")].map((shell) => ({
      mode: shell.dataset.previewMode,
      canvas: shell.style.getPropertyValue("--ds-canvas"),
      bg: shell.style.getPropertyValue("--ds-bg"),
    }));
  }

  it("draws each card's preview with that mode's own palette, System as Dark then Light", () => {
    renderSection();
    // Values from the css-vars snapshots in src/lib/design-system/__snapshots__.
    const dark = { mode: "dark", canvas: "#0f0e0c", bg: expect.any(String) };
    const light = { mode: "light", canvas: "#f3efec", bg: expect.any(String) };

    expect(previewShells(screen.getByRole("radio", { name: /^Dark/ }))).toEqual([dark]);
    expect(previewShells(screen.getByRole("radio", { name: /^Light/ }))).toEqual([light]);
    expect(previewShells(screen.getByRole("radio", { name: /^System/ }))).toEqual([dark, light]);
  });

  it("draws a preview from its mode's palette", () => {
    renderSection();
    expect(previewShells(screen.getByRole("radio", { name: /^Light/ }))[0].canvas).toBe(
      getDesignThemeCssVars(DESIGN_THEMES.light)["--ds-canvas"],
    );
  });

  it("is one radio group with the current preference checked and the only tab stop", () => {
    window.localStorage.setItem("app-theme-id", "dark");
    renderSection();

    const group = screen.getByRole("radiogroup", { name: "Appearance" });
    const radios = screen.getAllByRole("radio");
    expect(group).toContainElement(radios[0]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("moves and selects with the arrow keys, wrapping at the ends", () => {
    renderSection();
    const system = screen.getByRole("radio", { name: /^System/ });
    system.focus();

    fireEvent.keyDown(system, { key: "ArrowLeft" });
    const light = screen.getByRole("radio", { name: /^Light/ });
    expect(light).toHaveAttribute("aria-checked", "true");
    expect(light).toHaveFocus();
    expect(window.localStorage.getItem("app-theme-id")).toBe("light");

    fireEvent.keyDown(light, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /^System/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /^System/ })).toHaveFocus();
  });

  it("selects a card on click", () => {
    renderSection();
    fireEvent.click(screen.getByRole("radio", { name: /^Dark/ }));
    expect(screen.getByRole("radio", { name: /^Dark/ })).toHaveAttribute("aria-checked", "true");
  });
});
