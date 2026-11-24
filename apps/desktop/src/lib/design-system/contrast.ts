import { compositeOver, contrastRatio } from "@/lib/design-system/color";
import { getDesignThemeCssVars } from "@/lib/design-system/resolve-theme";
import { type AppTheme, type DesignThemeCssVars, STATUS_TONES } from "@/lib/design-system/theme-types";

export const CONTRAST_TEXT_LEVELS = ["primary", "secondary", "muted", "quiet"] as const;
export type ContrastTextLevel = (typeof CONTRAST_TEXT_LEVELS)[number];

export const CONTRAST_SURFACES = [
  "bg",
  "surface",
  "raised",
  "popover",
  "workbench",
  "workbenchRaised",
  "pane",
  "paneHeader",
] as const;
export type ContrastSurface = (typeof CONTRAST_SURFACES)[number];

/**
 * The CSS variables that paint each text level. A level lists every variable still in use for it,
 * so the weakest one is measured too; add a variable here when CSS starts reading a new one.
 */
export const CONTRAST_TEXT_VARS: Record<ContrastTextLevel, readonly `--${string}`[]> = {
  primary: ["--ds-text", "--ds-workbench-text", "--fg"],
  secondary: ["--ds-text-secondary", "--ds-workbench-text-secondary", "--text-secondary"],
  muted: ["--ds-text-muted", "--ds-workbench-text-muted", "--fg-muted", "--text-muted"],
  quiet: ["--ds-text-quiet", "--ds-workbench-text-quiet"],
};

export const CONTRAST_SURFACE_VARS: Record<ContrastSurface, `--${string}`> = {
  bg: "--ds-bg",
  surface: "--ds-surface",
  raised: "--ds-surface-raised",
  popover: "--ds-workbench-popover-bg",
  workbench: "--ds-workbench-surface",
  workbenchRaised: "--ds-workbench-surface-raised",
  pane: "--ds-workbench-pane-bg",
  paneHeader: "--ds-workbench-pane-header",
};

/**
 * What shows through each surface when it is translucent. The workbench surfaces sit on the CodeSpace
 * shell, a gradient from `--ds-workbench-bg-soft` to `--ds-workbench-bg`; both ends are measured and
 * the weaker one counts.
 */
const CONTRAST_SURFACE_BACKDROPS: Record<ContrastSurface, readonly `--${string}`[]> = {
  bg: ["--ds-bg"],
  surface: ["--ds-bg"],
  raised: ["--ds-bg"],
  popover: ["--ds-bg"],
  workbench: ["--ds-workbench-bg", "--ds-workbench-bg-soft"],
  workbenchRaised: ["--ds-workbench-bg", "--ds-workbench-bg-soft"],
  pane: ["--ds-workbench-bg", "--ds-workbench-bg-soft"],
  paneHeader: ["--ds-workbench-bg", "--ds-workbench-bg-soft"],
};

/** The weakest WCAG ratio of `color` on `surface`, over every backdrop that can show through it. */
function ratioOnSurface(vars: DesignThemeCssVars, color: string, surface: ContrastSurface): number {
  return Math.min(
    ...CONTRAST_SURFACE_BACKDROPS[surface].map((backdrop) =>
      contrastRatio(color, compositeOver(vars[CONTRAST_SURFACE_VARS[surface]], vars[backdrop])),
    ),
  );
}

export type ContrastPair = {
  text: ContrastTextLevel;
  surface: ContrastSurface;
  textVar: `--${string}`;
  surfaceVar: `--${string}`;
  ratio: number;
};

/**
 * Every text variable × surface pair a theme paints, with its WCAG ratio. A translucent surface is
 * measured as it shows over its backdrop (CONTRAST_SURFACE_BACKDROPS).
 */
export function themeContrastPairs(theme: AppTheme): ContrastPair[] {
  const vars = getDesignThemeCssVars(theme);
  return CONTRAST_TEXT_LEVELS.flatMap((text) =>
    CONTRAST_SURFACES.flatMap((surface) => {
      const surfaceVar = CONTRAST_SURFACE_VARS[surface];
      return CONTRAST_TEXT_VARS[text].map((textVar) => ({
        text,
        surface,
        textVar,
        surfaceVar,
        ratio: ratioOnSurface(vars, vars[textVar], surface),
      }));
    }),
  );
}

/** Status tones as text on every surface a card, menu or popover can show them on. */
export function themeStatusContrastPairs(theme: AppTheme): Omit<ContrastPair, "text">[] {
  const vars = getDesignThemeCssVars(theme);
  return STATUS_TONES.flatMap((tone) =>
    CONTRAST_SURFACES.map((surface) => {
      const surfaceVar = CONTRAST_SURFACE_VARS[surface];
      const textVar = `--ds-${tone}` as const;
      return {
        surface,
        textVar,
        surfaceVar,
        ratio: ratioOnSurface(vars, vars[textVar], surface),
      };
    }),
  );
}

/**
 * Each focus-ring variable against every surface it can sit on: a non-text indicator, so its WCAG
 * 1.4.11 floor is 3:1. A translucent ring is blended into the surface first, as it is painted.
 */
export function themeFocusRingContrast(theme: AppTheme): Omit<ContrastPair, "text">[] {
  const vars = getDesignThemeCssVars(theme);
  return (["--ds-focus-ring", "--ds-workbench-focus-ring"] as const).flatMap((textVar) =>
    CONTRAST_SURFACES.map((surface) => {
      const surfaceVar = CONTRAST_SURFACE_VARS[surface];
      return {
        surface,
        textVar,
        surfaceVar,
        ratio: ratioOnSurface(vars, vars[textVar], surface),
      };
    }),
  );
}
