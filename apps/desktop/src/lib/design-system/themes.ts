import { alpha, oklch } from "@/lib/design-system/color";
import type { AppTheme, SurfaceRamp, ThemeId } from "@/lib/design-system/theme-types";

// Each theme is written out in full: every colour the app paints for it lives in its palette, and
// getDesignThemeCssVars only maps palette entries to CSS variables. Tints are written as
// alpha(colour, opacity) against a named palette colour, so changing that colour carries them along.

/**
 * The one hue both themes are built on (OKLCH degrees): a warm stone, at a chroma low enough to read
 * as neutral. Every surface, text level, border and shadow below is this hue at another lightness,
 * which is what makes stacked panels look like one material instead of several.
 */
const WARM_HUE = 70;
const warm = (lightness: number, chroma: number) => oklch(lightness, chroma, WARM_HUE);

// Dark rises through lighter surfaces: a shadow barely shows on a dark ground, so each elevation
// step is +0.03 OKLCH lightness, edged by the 0.5px inset hairline.
const darkRamp = {
  canvas: warm(0.165, 0.004),
  bg: warm(0.195, 0.005),
  surface: warm(0.225, 0.006),
  raised: warm(0.255, 0.006),
  overlay: warm(0.285, 0.007),
  hairline: warm(0.36, 0.008),
} satisfies SurfaceRamp;

// The rail and every pane well share one step, one soft lift off the canvas, so the cards on the
// (glass) ground read as one material. The terminal used to be near-black #050506, a cold hole
// in a warm palette.
const darkWell = warm(0.2, 0.004);

const darkText = {
  primary: warm(0.965, 0.008),
  secondary: warm(0.82, 0.012),
  muted: warm(0.68, 0.012),
  quiet: warm(0.555, 0.01),
};

const darkWarning = oklch(0.83, 0.11, 82);

const darkUi = {
  background: darkRamp.bg,
  backgroundSecondary: darkRamp.canvas,
  backgroundCard: darkRamp.surface,
  backgroundElevated: darkRamp.raised,
  foreground: darkText.primary,
  foregroundMuted: darkText.muted,
  accent: warm(0.955, 0.006),
  accentForeground: darkRamp.canvas,
  border: alpha(darkText.primary, 0.11),
  borderSubtle: alpha(darkText.primary, 0.065),
  scrollbar: warm(0.4, 0.008),
} satisfies AppTheme["ui"];

const darkTerminal = {
  background: darkWell,
  foreground: "#f7f2ea",
  cursor: "#f5f2ef",
  cursorAccent: darkWell,
  selectionBackground: "rgba(245,242,239,0.18)",
  black: "#0c0b0a",
  // 4.68:1 on the warm well; the #847868 it replaces fell to 4.19:1 when the well lifted.
  brightBlack: "#8c806f",
  red: "#f08b83",
  brightRed: "#ffb4ad",
  green: "#9ccf9c",
  brightGreen: "#bde7bd",
  yellow: "#e7c37d",
  brightYellow: "#f4dca4",
  blue: "#9cb8dc",
  brightBlue: "#c1d5ef",
  magenta: "#d7abd9",
  brightMagenta: "#ecc9ed",
  cyan: "#98d5ce",
  brightCyan: "#bcebe5",
  white: "#d8d0c4",
  brightWhite: "#fff9ef",
} satisfies AppTheme["terminal"];

/**
 * Light theme's warm brown — DESIGN.md §6's rgba(78,50,23), moved onto the shared hue — and the one
 * tint every light border, hairline and shadow is drawn in, instead of black.
 */
const lightShadowInk = warm(0.33, 0.05);

// Light rises through shadow: the page is off-white, so a white card lifts off it by itself, and
// raised panels stay white with a deeper warm shadow rather than going grey.
const lightRamp = {
  canvas: warm(0.955, 0.006),
  bg: warm(0.978, 0.004),
  surface: "#ffffff",
  raised: "#ffffff",
  overlay: "#ffffff",
  hairline: warm(0.9, 0.008),
} satisfies SurfaceRamp;

const lightText = {
  primary: warm(0.2, 0.008),
  secondary: warm(0.4, 0.012),
  muted: warm(0.52, 0.012),
  quiet: warm(0.62, 0.01),
};

const lightWarning = oklch(0.53, 0.11, 65);

const lightUi = {
  background: lightRamp.bg,
  backgroundSecondary: lightRamp.canvas,
  backgroundCard: lightRamp.surface,
  backgroundElevated: lightRamp.raised,
  foreground: lightText.primary,
  foregroundMuted: lightText.muted,
  accent: warm(0.22, 0.008),
  accentForeground: "#ffffff",
  border: alpha(lightShadowInk, 0.13),
  borderSubtle: alpha(lightShadowInk, 0.075),
  scrollbar: warm(0.82, 0.008),
} satisfies AppTheme["ui"];

const lightTerminal = {
  background: "#ffffff",
  foreground: "#1f1b17",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(0,0,0,0.14)",
  black: "#201c18",
  brightBlack: "#5f5a54",
  red: "#9f342b",
  brightRed: "#c1493f",
  green: "#47733e",
  brightGreen: "#537e4b",
  yellow: "#906621",
  brightYellow: "#986b24",
  blue: "#3f638f",
  brightBlue: "#4f75a6",
  magenta: "#82568d",
  brightMagenta: "#965ea2",
  cyan: "#3f7774",
  brightCyan: "#467c7a",
  white: "#d7d0c8",
  brightWhite: "#777169",
} satisfies AppTheme["terminal"];

export const DESIGN_THEMES: Record<ThemeId, AppTheme> = {
  dark: {
    id: "dark",
    name: "Dark",
    type: "dark",
    ramp: darkRamp,
    semantic: {
      success: oklch(0.79, 0.11, 152),
      warning: darkWarning,
      danger: oklch(0.74, 0.13, 25),
      info: oklch(0.78, 0.08, 245),
    },
    ui: darkUi,
    text: {
      secondary: darkText.secondary,
      quiet: darkText.quiet,
      workbenchSecondary: darkText.secondary,
      workbenchMuted: darkText.muted,
      workbenchQuiet: darkText.quiet,
      legacySecondary: darkText.secondary,
      legacyMuted: darkText.muted,
    },
    fill: {
      soft: alpha(darkText.primary, 0.036),
      hover: alpha(darkText.primary, 0.062),
      active: alpha(darkText.primary, 0.085),
      legacyHover: alpha(darkText.primary, 0.07),
    },
    surface: {
      // One soft step off the canvas: the fill alone separates the sidebar, so it needs no line.
      rail: darkWell,
      railEdge: "transparent",
      // 88%, measured: at 68% the Dark material lifted the ground level with the rail.
      glassGround: alpha(darkRamp.canvas, 0.88),
      stone: alpha(darkUi.accent, 0.12),
      workbench: alpha(darkRamp.surface, 0.86),
      workbenchRaised: alpha(darkRamp.raised, 0.82),
      pane: alpha(darkRamp.canvas, 0.72),
      // The strip is the body's own fill: one card, not a lid on a box. Focus draws its edge.
      paneHeader: "transparent",
      accentSoft: alpha(darkUi.accent, 0.11),
      bubbleAi: alpha(darkRamp.raised, 0.42),
      popover: darkRamp.overlay,
      popoverStrong: darkRamp.surface,
      popoverSoft: darkRamp.raised,
      popoverBorder: alpha(darkText.primary, 0.16),
    },
    focusRing: {
      base: alpha(darkUi.accent, 0.5),
      workbench: alpha(darkUi.accent, 0.5),
    },
    shadow: {
      ink: "#000000",
      edge: `${alpha(darkText.primary, 0.085)} 0 0 0 0.5px inset`,
      soft: "rgba(0,0,0,0.34) 0 0 1px, rgba(0,0,0,0.22) 0 12px 30px",
      lift: "rgba(0,0,0,0.26) 0 16px 36px",
      popover: "rgba(0,0,0,0.28) 0 2px 6px, rgba(0,0,0,0.34) 0 14px 36px",
      workbenchEdge: `${alpha(darkText.primary, 0.075)} 0 0 0 0.5px inset`,
      workbenchSoft: "rgba(0,0,0,0.34) 0 0 1px, rgba(0,0,0,0.18) 0 10px 26px",
      workbenchLift: "rgba(0,0,0,0.26) 0 14px 34px",
    },
    status: {
      tabDirty: alpha(darkWarning, 0.82),
      dangerForeground: darkUi.accentForeground,
      folderIcon: alpha(darkWarning, 0.72),
      gold: "#d6b46e",
      goldOnAccent: "#7a5a1c",
    },
    terminal: darkTerminal,
  },
  light: {
    id: "light",
    name: "Light",
    type: "light",
    ramp: lightRamp,
    semantic: {
      success: oklch(0.5, 0.11, 150),
      warning: lightWarning,
      danger: oklch(0.52, 0.16, 28),
      info: oklch(0.5, 0.11, 250),
    },
    ui: lightUi,
    text: {
      secondary: lightText.secondary,
      quiet: lightText.quiet,
      workbenchSecondary: lightText.secondary,
      workbenchMuted: lightText.muted,
      workbenchQuiet: lightText.quiet,
      legacySecondary: lightText.secondary,
      legacyMuted: lightText.muted,
    },
    fill: {
      soft: alpha(lightText.primary, 0.045),
      hover: alpha(lightText.primary, 0.07),
      active: alpha(lightText.primary, 0.1),
      legacyHover: alpha(lightText.primary, 0.07),
    },
    surface: {
      // Light mirrors Dark: the rail lifts one step above the ground (paper over stone) and drops
      // its line. On the canvas step it measured level with the glass ground and vanished.
      // Near-white with the warmth all but gone: the paper tint read as beige next to white panes.
      rail: warm(0.988, 0.002),
      railEdge: "transparent",
      // A step darker than the canvas, so the rail and the white panes both sit above it; low
      // chroma for the same reason.
      glassGround: alpha(warm(0.925, 0.004), 0.9),
      stone: lightRamp.canvas,
      workbench: alpha(lightRamp.surface, 0.86),
      workbenchRaised: alpha(lightRamp.raised, 0.94),
      pane: alpha(lightRamp.surface, 0.74),
      // The strip is the body's own fill: one card, not a lid on a box. Focus draws its edge.
      paneHeader: "transparent",
      accentSoft: alpha(lightRamp.canvas, 0.72),
      bubbleAi: alpha(lightRamp.canvas, 0.72),
      popover: lightRamp.overlay,
      popoverStrong: lightRamp.surface,
      popoverSoft: lightRamp.bg,
      popoverBorder: lightUi.border,
    },
    focusRing: {
      base: alpha(lightUi.accent, 0.6),
      workbench: alpha(lightUi.accent, 0.6),
    },
    shadow: {
      ink: lightShadowInk,
      edge: `${alpha(lightShadowInk, 0.08)} 0 0 0 0.5px inset`,
      soft: `${alpha(lightShadowInk, 0.07)} 0 0 0 1px, ${alpha(lightShadowInk, 0.035)} 0 8px 22px`,
      lift: `${alpha(lightShadowInk, 0.06)} 0 1px 2px, ${alpha(lightShadowInk, 0.05)} 0 6px 16px`,
      popover: `${alpha(lightShadowInk, 0.06)} 0 2px 6px, ${alpha(lightShadowInk, 0.1)} 0 14px 32px`,
      workbenchEdge: `${alpha(lightShadowInk, 0.075)} 0 0 0 0.5px inset`,
      workbenchSoft: `${alpha(lightShadowInk, 0.055)} 0 0 0 1px, ${alpha(lightShadowInk, 0.035)} 0 6px 16px`,
      workbenchLift: `${alpha(lightShadowInk, 0.045)} 0 12px 28px`,
    },
    status: {
      dangerForeground: lightUi.accentForeground,
      tabDirty: alpha(lightWarning, 0.82),
      folderIcon: alpha(lightWarning, 0.72),
      gold: "#9a7428",
      goldOnAccent: "#e9cf94",
    },
    terminal: lightTerminal,
  },
};

export const DESIGN_THEME_MODES = ["dark", "light"] as const;
