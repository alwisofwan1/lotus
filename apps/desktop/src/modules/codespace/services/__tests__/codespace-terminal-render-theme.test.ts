import { describe, expect, it } from "vitest";
import { getDesignTheme, getDesignThemeCssVars, DESIGN_THEMES } from "@/lib/design-system";
import {
  resolveCodeSpaceTerminalRenderMetrics,
  resolveCodeSpaceTerminalRenderTheme,
} from "../codespace-terminal-render-theme";

describe("resolveCodeSpaceTerminalRenderTheme", () => {
  it("keeps dark CodeSpace terminal colors aligned with the active theme", () => {
    const theme = getDesignTheme("dark");

    expect(resolveCodeSpaceTerminalRenderTheme(theme)).toBe(theme.terminal);
    expect(resolveCodeSpaceTerminalRenderTheme(theme).background).toBe("#171614");
    expect(resolveCodeSpaceTerminalRenderTheme(theme).foreground).toBe("#f7f2ea");
  });

  it("preserves light terminal themes for contrast/accessibility", () => {
    const theme = getDesignTheme("light");

    expect(resolveCodeSpaceTerminalRenderTheme(theme)).toBe(theme.terminal);
  });

  it("uses a comfortable terminal metric profile instead of compact canvas metrics", () => {
    expect(resolveCodeSpaceTerminalRenderMetrics()).toEqual({
      lineHeight: 1,
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 650,
    });
  });
});

// Single-source-of-truth invariant: the terminal background resolved by the
// render theme function must equal the --ds-workbench-terminal-bg CSS var
// emitted by the design system. This guarantees the CSS variable chain alone
// is sufficient and no per-component inline style override is needed.
describe("terminal background single source of truth", () => {
  it("render theme background equals --ds-workbench-terminal-bg for every built-in theme", () => {
    for (const theme of Object.values(DESIGN_THEMES)) {
      const renderBg = resolveCodeSpaceTerminalRenderTheme(theme).background;
      const cssVarBg = getDesignThemeCssVars(theme)["--ds-workbench-terminal-bg"];
      expect({ themeId: theme.id, renderBg }).toEqual({ themeId: theme.id, renderBg: cssVarBg });
    }
  });

  it("dark theme render background is a solid opaque hex (no rgba — allowTransparency is false)", () => {
    const theme = getDesignTheme("dark");
    const bg = resolveCodeSpaceTerminalRenderTheme(theme).background;
    expect(bg).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("light theme render background is a solid opaque hex", () => {
    const theme = getDesignTheme("light");
    const bg = resolveCodeSpaceTerminalRenderTheme(theme).background;
    expect(bg).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
