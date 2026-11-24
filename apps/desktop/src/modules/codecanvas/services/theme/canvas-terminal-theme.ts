// CodeCanvas "Adaptive Ink" terminal palette resolver (ADR-0033 follow-up).
//
// xterm needs concrete colours in JS — it cannot read the canvas CSS variables.
// This is the single place the xterm palette (foreground / cursor / ANSI / selection)
// is derived from the active Artisan theme's `mode`. The same resolver serves both the
// Terminal Node and the live Terminal Agent.
//
// The BACKGROUND has two modes:
//   • with `background` — an opaque floor from resolveTerminalFloor(), for callers running
//     `allowTransparency: false`. xterm owns the ground and gets the background-run fast path.
//   • without it — transparent, the legacy arrangement where the CSS ink-floor
//     (terminal-node.css, --canvas-terminal-bg) owns the surface.

import type { TerminalTheme } from "@/lib/design-system";

export interface CanvasTerminalThemeInput {
  /** Active Artisan theme mode. Light themes need dark ink to stay legible. */
  mode: "dark" | "light";
  /**
   * Opaque floor for `theme.background`, from `resolveTerminalFloor()`.
   *
   * Supplying it is what lets the caller run xterm with `allowTransparency: false`, which is
   * where the render win lives: both the DOM and WebGL renderers can then take their
   * background-run fast path instead of compositing alpha per cell.
   *
   * Omit it to keep the legacy transparent ground, where the CSS ink-floor owns the surface.
   */
  background?: string;
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";

// Light ink on a dark ink-floor. ANSI ramp is tuned for a dark ground; ANSI
// "black" maps to a faint surface shadow (not pure black) so black-fg cells read
// as depth rather than a hole.
const DARK_MODE: TerminalTheme = {
  background: TRANSPARENT,
  foreground: "rgb(232, 238, 246)",
  cursor: "rgb(125, 249, 255)",
  cursorAccent: "rgb(6, 8, 18)",
  selectionBackground: "rgba(125, 249, 255, 0.28)",
  black: "rgb(55, 48, 47)",
  brightBlack: "rgba(167, 176, 196, 0.58)",
  red: "rgb(248, 113, 113)",
  brightRed: "rgb(252, 165, 165)",
  green: "rgb(52, 211, 153)",
  brightGreen: "rgb(110, 231, 183)",
  yellow: "rgb(251, 191, 36)",
  brightYellow: "rgb(252, 211, 77)",
  blue: "rgb(96, 165, 250)",
  brightBlue: "rgb(147, 197, 253)",
  magenta: "rgb(192, 132, 252)",
  brightMagenta: "rgb(216, 180, 254)",
  cyan: "rgb(34, 211, 238)",
  brightCyan: "rgb(103, 232, 249)",
  white: "rgb(232, 238, 246)",
  brightWhite: "rgb(248, 250, 255)",
};

// Dark ink on a light ink-floor. The normal ANSI set is deepened so every colour clears WCAG AA
// (≈4.5:1) on a near-white ground; bright variants sit a touch lighter for emphasis. ANSI "white"
// flips to a light surface tone so white-fg cells read as a soft highlight rather than invisible —
// it measures ~1.01:1 on Garden of Dawn's floor, which is that intent working, not a failure.
//
// THAT INTENT NO LONGER REACHES TEXT, and the distinction matters. A runner that uses ANSI white
// for BODY text — Claude Code's `dark-ansi` theme maps `text` to it, and Pi paints its panel body
// with it — was writing in invisible ink at 1.01:1. Deepening it here cannot be the fix: this
// palette is background-blind, and white must stay white on a dark panel while becoming ink on
// paper. `live-agent-ansi-normalizer` now folds these slots against the ground the glyph actually
// sits on, via `ansiPaletteOrder` below, and leaves a slot alone once it clears the bar. So the
// values here are the AUTHORED intent; the stream decides what survives it on a light surface.
// Ten of them measured under AA on that floor — see the palette suite in the normaliser's tests.
//
// "Near-white ground" was the assumption while no builtin was light. The deepening below was done
// against Crimson Zen, whose floor was the wallpaper's own mist, rgb(236,227,224): on that ground
// three of the normal colours slipped under AA (green 4.22, yellow 4.37, cyan 4.24) and each was
// deepened along its own hue until it cleared 4.5:1 there (4.51/4.51/4.55).
//
// Garden of Dawn replaced that theme and its floor is rgb(247,230,214) — LIGHTER, so every colour
// gained: black 13.99, fg 12.35, blue 5.16, red 4.98, magenta 4.83, cyan 4.71, green 4.68,
// yellow 4.68. The deepening is kept rather than reverted, because it is what makes this set safe
// on ANY light floor down to the one it was measured on, and a future light theme is free to sit
// there again.
//
// The bright* variants are NOT held to that bar, and deliberately: they exist to sit a touch
// lighter than their normal counterpart for emphasis, so once the normal colour only just clears
// 4.5:1, its bright twin mathematically cannot — deepening it to AA would collapse the two into
// the same colour and lose the distinction that is the whole point. `brightBlack` is the same
// story with a different cause: it is the dim/comment tone, low-contrast on purpose in both modes
// (DARK_MODE's is literally alpha 0.58). It measures 3.83:1 here, which is that intent working.
const LIGHT_MODE: TerminalTheme = {
  background: TRANSPARENT,
  foreground: "rgb(31, 39, 51)",
  cursor: "rgb(71, 89, 201)",
  cursorAccent: "rgb(244, 246, 250)",
  selectionBackground: "rgba(71, 89, 201, 0.22)",
  black: "rgb(24, 28, 38)",
  brightBlack: "rgb(107, 114, 128)",
  red: "rgb(179, 53, 46)",
  brightRed: "rgb(200, 62, 54)",
  green: "rgb(20, 117, 79)",
  brightGreen: "rgb(28, 138, 94)",
  yellow: "rgb(142, 92, 10)",
  brightYellow: "rgb(166, 108, 12)",
  blue: "rgb(39, 93, 184)",
  brightBlue: "rgb(47, 108, 205)",
  magenta: "rgb(139, 63, 192)",
  brightMagenta: "rgb(155, 74, 210)",
  cyan: "rgb(13, 111, 138)",
  brightCyan: "rgb(17, 132, 163)",
  white: "rgb(230, 232, 238)",
  brightWhite: "rgb(248, 250, 252)",
};

export function resolveCanvasTerminalTheme({
  mode,
  background,
}: CanvasTerminalThemeInput): TerminalTheme {
  const palette = mode === "light" ? LIGHT_MODE : DARK_MODE;
  // Spread, never assign: DARK_MODE/LIGHT_MODE are module-level constants shared by every
  // node on the canvas, so writing the floor into them would leak one node's ground into all
  // the others.
  return background ? { ...palette, background } : palette;
}

/**
 * The 16 ANSI slots as a wire-ordered array, for consumers that index by SGR code.
 *
 * `live-agent-ansi-normalizer` needs the colours xterm WOULD paint slots 0-15 with, so it can
 * fold the pale ones against the ground a glyph actually sits on. Ten of LIGHT_MODE's entries
 * measure under AA on Garden of Dawn's floor, and they cannot be fixed above — a palette is
 * background-blind, and ANSI white has to be white on a dark panel and ink on the paper.
 *
 * Order is a wire format, not a preference: the normaliser maps `30-37` to 0-7 and `90-97` to
 * 8-15 by arithmetic, so a swap here repaints cells with no error raised anywhere.
 */
export function ansiPaletteOrder(theme: TerminalTheme): readonly string[] {
  return [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ];
}
