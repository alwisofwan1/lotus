import { describe, expect, it } from "vitest";
import {
  DESIGN_THEMES,
  getDesignTheme,
  getDesignThemeCssVars,
  normalizeThemePreference,
  resolveThemeMode,
} from "@/lib/design-system";

describe("design-system theme resolver", () => {
  it("normalizes curated and legacy theme values", () => {
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("light")).toBe("light");
    // Gruvbox Dark/Light were retired (2026-10); their users land on the matching mode
    expect(normalizeThemePreference("gruvbox-dark")).toBe("dark");
    expect(normalizeThemePreference("gruvbox-light")).toBe("light");
    expect(normalizeThemePreference("bridgemind")).toBe("dark");
    expect(normalizeThemePreference("paper")).toBe("light");
    // legacy "gruvbox" (old theme ID) migrates to plain dark
    expect(normalizeThemePreference("gruvbox")).toBe("dark");
    expect(normalizeThemePreference("unknown")).toBeNull();
    // A legacy-map lookup must not reach Object.prototype
    expect(normalizeThemePreference("constructor")).toBeNull();
  });

  it("resolves system preference from the current system mode", () => {
    expect(resolveThemeMode("system", "dark")).toBe("dark");
    expect(resolveThemeMode("system", "light")).toBe("light");
    expect(resolveThemeMode("dark", "light")).toBe("dark");
  });

  it("emits legacy compatibility vars and design-system vars", () => {
    const vars = getDesignThemeCssVars(getDesignTheme("dark"));
    expect(vars["--ds-bg"]).toBe("#161513");
    expect(vars["--ds-workbench-bg"]).toBe("#161513");
    expect(vars["--ds-workbench-surface"]).toBe("rgba(30,27,25,0.86)");
    expect(vars["--ds-workbench-border"]).toBe("rgba(247,243,238,0.065)");
    expect(vars["--bg"]).toBe("#161513");
    expect(vars["--fg"]).toBe("#f7f3ee");
  });

  it("emits workbench extension tokens that replace hardcoded CSS colors", () => {
    const dark = getDesignThemeCssVars(getDesignTheme("dark"));
    const light = getDesignThemeCssVars(getDesignTheme("light"));

    // Tab active indicator follows the theme accent
    expect(dark["--ds-workbench-tab-active-color"]).toBe(DESIGN_THEMES.dark.ui.accent);
    expect(light["--ds-workbench-tab-active-color"]).toBe(DESIGN_THEMES.light.ui.accent);

    // Tab dirty indicator is derived from terminal yellow (warning semantic)
    expect(dark["--ds-workbench-tab-dirty-color"]).toMatch(/^rgba\(/);
    expect(light["--ds-workbench-tab-dirty-color"]).toMatch(/^rgba\(/);

    // Folder icon derived from terminal yellow with 72% opacity
    expect(dark["--ds-workbench-folder-icon"]).toMatch(/^rgba\(/);
    expect(light["--ds-workbench-folder-icon"]).toMatch(/^rgba\(/);

    // Rail accent follows the theme accent
    expect(dark["--ds-workbench-rail-accent"]).toBe(DESIGN_THEMES.dark.ui.accent);
    expect(light["--ds-workbench-rail-accent"]).toBe(DESIGN_THEMES.light.ui.accent);

    // Popover background family covers all three tiers
    expect(dark["--ds-workbench-popover-bg"]).toBeDefined();
    expect(dark["--ds-workbench-popover-bg-strong"]).toBeDefined();
    expect(dark["--ds-workbench-popover-bg-soft"]).toBeDefined();
    expect(dark["--ds-workbench-popover-border"]).toBeDefined();
    expect(light["--ds-workbench-popover-bg"]).toBeDefined();
    expect(light["--ds-workbench-popover-bg-strong"]).toBeDefined();
    expect(light["--ds-workbench-popover-bg-soft"]).toBeDefined();
    expect(light["--ds-workbench-popover-border"]).toBeDefined();
  });

  it("ships exactly the dark and light themes", () => {
    expect(Object.keys(DESIGN_THEMES).sort()).toEqual(["dark", "light"]);
  });
});
