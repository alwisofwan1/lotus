import { afterEach, describe, expect, it, vi } from "vitest";

describe("detectMonoFontFamily", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a terminal-native mono stack before the bundled Atkinson fallback", async () => {
    vi.resetModules();
    const { detectMonoFontFamily } = await import("./fonts");

    const family = detectMonoFontFamily();

    expect(family.startsWith('"JetBrains Mono"')).toBe(true);
    expect(family.indexOf("JetBrains Mono")).toBeLessThan(family.indexOf("SFMono-Regular"));
    expect(family.indexOf("Menlo")).toBeLessThan(family.indexOf("Atkinson Hyperlegible Mono Variable"));
    expect(family).toContain("Atkinson Hyperlegible Mono Variable");
  });

  it("keeps Nerd Fonts as fallbacks instead of replacing the primary text font", async () => {
    vi.resetModules();
    Object.defineProperty(document, "fonts", {
      value: {
        check: vi.fn((query: string) => query.includes("JetBrainsMono Nerd Font")),
      },
      configurable: true,
    });

    const { detectMonoFontFamily } = await import("./fonts");

    const family = detectMonoFontFamily();
    expect(family.startsWith('"JetBrains Mono", "JetBrainsMono Nerd Font"')).toBe(true);
  });
});
