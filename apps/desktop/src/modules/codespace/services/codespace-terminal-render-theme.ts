import type { AppTheme, TerminalTheme } from "@/lib/design-system";

export interface CodeSpaceTerminalRenderMetrics {
  lineHeight: number;
  letterSpacing: number;
  fontWeight: number;
  fontWeightBold: number;
}

/**
 * `lineHeight` is 1.0 because CodeSpace renders through xterm's DOM renderer, and there the
 * cell is taller than the glyph box: at fontSize 13, lineHeight 1.12 measured a 19px cell over a
 * ~17px glyph. Ordinary text does not notice the 2px. Block art does — U+2588 rows stop touching,
 * so an agent banner, a box frame and a progress bar all arrive with a seam through every row.
 *
 * xterm's own answer to that is `customGlyphs`, which draws block and box-drawing characters to
 * the full cell instead of asking the font. Its typings say it plainly: "this doesn't work with
 * the DOM renderer". The option is set on every terminal we build and is inert until a
 * canvas/WebGL renderer is live, so 1.0 is what closes the seam today.
 *
 * Measured 2026-09-20 against the same font stack and options in an isolated xterm page: at 1.12
 * two consecutive block rows render with a gap, at 1.0 they merge.
 */
const CODESPACE_COMFORTABLE_TERMINAL_METRICS: CodeSpaceTerminalRenderMetrics = {
  lineHeight: 1.0,
  letterSpacing: 0,
  fontWeight: 400,
  fontWeightBold: 650,
};

/**
 * CodeSpace terminal colors follow the active theme. The smoothing work lives
 * in xterm metrics and optional focused-pane WebGL, not in a hard-coded dark
 * background, so theme changes remain visually coherent across the workbench.
 */
export function resolveCodeSpaceTerminalRenderTheme(theme: AppTheme): TerminalTheme {
  return theme.terminal;
}

export function resolveCodeSpaceTerminalRenderMetrics(): CodeSpaceTerminalRenderMetrics {
  return CODESPACE_COMFORTABLE_TERMINAL_METRICS;
}
