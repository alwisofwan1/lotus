import { describe, expect, it } from "vitest";
import { buildThemeBootstrapScript } from "@/lib/design-system/theme-bootstrap";

/*
 * The bootstrap runs before React, so it carries its own copy of the preference normalizer. It once
 * drifted: a stored "gruvbox-dark" was unknown to it and fell back to System, so those users saw the
 * System theme until React caught up. These tests execute the shipped string, not a reimplementation.
 */
function runBootstrap(stored: string | null, systemDark: boolean) {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const fakeWindow = {
    localStorage: { getItem: (key: string) => (key === "app-theme-id" ? stored : null) },
    matchMedia: () => ({ matches: systemDark }),
  };
  const fakeDocument = {
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    },
  };
  new Function("window", "document", buildThemeBootstrapScript())(fakeWindow, fakeDocument);
  return { attributes, properties };
}

describe("theme bootstrap script", () => {
  it("applies a stored dark or light preference regardless of the system mode", () => {
    expect(runBootstrap("dark", false).attributes.get("data-theme-type")).toBe("dark");
    expect(runBootstrap("light", true).attributes.get("data-theme-type")).toBe("light");
  });

  it("follows the system mode for System and for an empty store", () => {
    expect(runBootstrap("system", false).attributes.get("data-theme-type")).toBe("light");
    expect(runBootstrap(null, true).attributes.get("data-theme-type")).toBe("dark");
    expect(runBootstrap(null, true).attributes.get("data-theme-preference")).toBe("system");
  });

  it("migrates retired Gruvbox preferences to the matching mode without a System detour", () => {
    const light = runBootstrap("gruvbox-light", true);
    expect(light.attributes.get("data-theme-type")).toBe("light");
    expect(light.attributes.get("data-theme-preference")).toBe("light");

    const dark = runBootstrap("gruvbox-dark", false);
    expect(dark.attributes.get("data-theme-type")).toBe("dark");
    expect(dark.attributes.get("data-theme-preference")).toBe("dark");
  });

  it("migrates the older retired theme ids", () => {
    expect(runBootstrap("bridgemind", false).attributes.get("data-theme-preference")).toBe("dark");
    expect(runBootstrap("paper", true).attributes.get("data-theme-preference")).toBe("light");
  });

  it("writes the resolved theme's CSS variables", () => {
    expect(runBootstrap("light", true).properties.get("--bg")).toBe("#faf7f5");
  });
});
