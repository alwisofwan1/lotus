import { describe, expect, it } from "vitest";
import {
  APP_THEME_SETTINGS_KEY,
  readAppThemeIdFromSettings,
  withAppThemeSetting,
} from "./theme-settings";

describe("theme-settings", () => {
  it("reads the Lotus-specific theme key first", () => {
    expect(
      readAppThemeIdFromSettings({
        [APP_THEME_SETTINGS_KEY]: "bridgemind",
        theme: "gruvbox",
      }),
    ).toBe("dark");
  });

  it("falls back to legacy top-level theme and normalizes it", () => {
    expect(readAppThemeIdFromSettings({ theme: "gruvbox" })).toBe("dark");
    expect(readAppThemeIdFromSettings({ theme: "paper" })).toBe("light");
  });

  it("reads the new curated theme preferences", () => {
    expect(readAppThemeIdFromSettings({ [APP_THEME_SETTINGS_KEY]: "system" })).toBe("system");
    expect(readAppThemeIdFromSettings({ [APP_THEME_SETTINGS_KEY]: "dark" })).toBe("dark");
    expect(readAppThemeIdFromSettings({ [APP_THEME_SETTINGS_KEY]: "light" })).toBe("light");
  });

  it("migrates a retired Gruvbox preference to the matching mode", () => {
    expect(readAppThemeIdFromSettings({ [APP_THEME_SETTINGS_KEY]: "gruvbox-dark" })).toBe("dark");
    expect(readAppThemeIdFromSettings({ [APP_THEME_SETTINGS_KEY]: "gruvbox-light" })).toBe("light");
    expect(withAppThemeSetting({ [APP_THEME_SETTINGS_KEY]: "gruvbox-light" }, "gruvbox-light")).toEqual({
      [APP_THEME_SETTINGS_KEY]: "light",
    });
  });

  it("does not treat Claude theme names as Lotus themes", () => {
    expect(readAppThemeIdFromSettings({ theme: "dark" })).toBeUndefined();
  });

  it("moves Lotus theme persistence away from Claude's top-level theme key and normalizes values", () => {
    expect(withAppThemeSetting({ theme: "gruvbox", effortLevel: "medium" }, "void")).toEqual({
      [APP_THEME_SETTINGS_KEY]: "dark",
      effortLevel: "medium",
    });
  });

  it("preserves non-Lotus Claude theme values", () => {
    expect(withAppThemeSetting({ theme: "claude-dark" }, "system")).toEqual({
      [APP_THEME_SETTINGS_KEY]: "system",
      theme: "claude-dark",
    });
  });
});
