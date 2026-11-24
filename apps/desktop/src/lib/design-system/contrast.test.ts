import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  CONTRAST_SURFACES,
  CONTRAST_TEXT_LEVELS,
  DESIGN_THEME_MODES,
  getDesignTheme,
  getDesignThemeCssVars,
  STATUS_TONES,
  themeContrastPairs,
  themeFocusRingContrast,
  themeStatusContrastPairs,
  type ContrastTextLevel,
  type ResolvedThemeMode,
} from "@/lib/design-system";

// Lowest ratio each text level may reach on any surface: the PLAN.md §3 targets. `quiet` is for
// icons, placeholders and disabled text only, never for a sentence someone has to read.
const TEXT_FLOOR: Record<ContrastTextLevel, number> = { primary: 12, secondary: 7, muted: 4.5, quiet: 3 };
const CONTRAST_FLOOR: Record<ResolvedThemeMode, Record<ContrastTextLevel, number>> = {
  dark: TEXT_FLOOR,
  light: TEXT_FLOOR,
};

describe("theme text contrast", () => {
  it.each(DESIGN_THEME_MODES)("%s lists every text level on every surface", (mode) => {
    const pairs = new Set(themeContrastPairs(getDesignTheme(mode)).map((p) => `${p.text}/${p.surface}`));
    expect([...pairs].sort()).toEqual(
      CONTRAST_TEXT_LEVELS.flatMap((t) => CONTRAST_SURFACES.map((s) => `${t}/${s}`)).sort(),
    );
    expect(CONTRAST_TEXT_LEVELS).toEqual(["primary", "secondary", "muted", "quiet"]);
    expect(CONTRAST_SURFACES).toEqual(["bg", "surface", "raised", "popover", "workbench", "workbenchRaised", "pane", "paneHeader"]);
  });

  it("measures a translucent workbench surface over the darker and the lighter end of the shell behind it", () => {
    const vars = getDesignThemeCssVars(getDesignTheme("light"));
    const ratios = themeContrastPairs(getDesignTheme("light"))
      .filter((p) => p.textVar === "--ds-workbench-text-quiet" && p.surface === "paneHeader")
      .map((p) => p.ratio);
    const onEnd = (backdrop: `--${string}`) =>
      contrastRatio(vars["--ds-workbench-text-quiet"], compositeOver(vars["--ds-workbench-pane-header"], vars[backdrop]));
    expect(ratios).toEqual([Math.min(onEnd("--ds-workbench-bg"), onEnd("--ds-workbench-bg-soft"))]);
  });

  it("measures the CSS variables the app actually paints", () => {
    const pair = themeContrastPairs(getDesignTheme("light")).find(
      (p) => p.textVar === "--fg-muted" && p.surfaceVar === "--ds-bg",
    );
    const vars = getDesignThemeCssVars(getDesignTheme("light"));
    expect(pair?.ratio).toBe(contrastRatio(vars["--fg-muted"], vars["--ds-bg"]));
  });

  for (const mode of DESIGN_THEME_MODES) {
    it.each(themeContrastPairs(getDesignTheme(mode)))(
      `${mode}: $textVar ($text) on $surfaceVar stays at or above its floor`,
      ({ text, ratio }) => {
        expect(ratio).toBeGreaterThanOrEqual(CONTRAST_FLOOR[mode][text]);
      },
    );
  }
});

describe("theme status colours", () => {
  it("are the four semantic tones", () => {
    expect(STATUS_TONES).toEqual(["success", "warning", "danger", "info"]);
  });

  for (const mode of DESIGN_THEME_MODES) {
    it.each(themeStatusContrastPairs(getDesignTheme(mode)))(
      `${mode}: $textVar on $surfaceVar reads at AA (4.5:1)`,
      ({ ratio }) => {
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      },
    );
  }
});

describe("danger fill", () => {
  it.each(DESIGN_THEME_MODES)("%s: --ds-danger-text reads at AA on a --ds-danger fill", (mode) => {
    const vars = getDesignThemeCssVars(getDesignTheme(mode));
    expect(contrastRatio(vars["--ds-danger-text"], vars["--ds-danger"])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("theme focus ring", () => {
  for (const mode of DESIGN_THEME_MODES) {
    it.each(themeFocusRingContrast(getDesignTheme(mode)))(
      `${mode}: $textVar stands out from $surfaceVar (3:1, WCAG 1.4.11)`,
      ({ ratio }) => {
        expect(ratio).toBeGreaterThanOrEqual(3);
      },
    );
  }
});
