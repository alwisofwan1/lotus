import { detectMonoFontFamily } from "@/lib/fonts";

/**
 * One type scale for every canvas terminal (ADR-0033). Before this the Terminal Node ran the
 * deliberately tuned codespace metrics (CODESPACE_COMFORTABLE_TERMINAL_METRICS: 13/1.12) while
 * the Live Agent Terminal copy-pasted SwarmAgentPTYPanel's 12/1.3 — an ~8% size and ~16% leading
 * mismatch between two nodes of the same family sitting side by side on one board.
 */
export interface CanvasTerminalTypography {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontWeight: number;
  fontWeightBold: number;
}

export const CANVAS_TERMINAL_TYPOGRAPHY: CanvasTerminalTypography = {
  fontSize: 13,
  lineHeight: 1.12,
  letterSpacing: 0,
  fontWeight: 400,
  // 700, not 650: layout.tsx only imports @fontsource/jetbrains-mono weights 400 + 700, so
  // asking xterm for 650 just made CSS font matching promote to 700 anyway.
  fontWeightBold: 700,
};

/** Both canvas terminal families read the same detected mono stack (JetBrains Mono + Nerd Font
 * fallbacks), so prompt glyphs render identically instead of one node tofu-ing powerline icons. */
export function resolveCanvasTerminalFontFamily(): string {
  return detectMonoFontFamily();
}

/**
 * document.fonts.check() can throw on unusual input in some engines, and is unavailable outright
 * in non-browser test environments — both must read as "not loaded yet" rather than crash.
 */
export function isCanvasTerminalPrimaryFontLoaded(): boolean {
  if (typeof document === "undefined" || !document.fonts) return false;
  try {
    return document.fonts.check('13px "JetBrains Mono"');
  } catch {
    return false;
  }
}

/**
 * Force xterm to re-measure its glyph cell against the currently resolved font stack.
 *
 * A bare `term.options.fontFamily = resolveCanvasTerminalFontFamily()` does NOT do this. Two
 * things conspire, both verified against the shipped bundle:
 *
 *   • xterm's option setter is guarded —
 *     `this.rawOptions[key] !== value && (this.rawOptions[key] = value, this._onOptionChange.fire(key))`
 *   • `CharSizeService` only re-measures from
 *     `onMultipleOptionChange(["fontFamily", "fontSize"], () => this.measure())`
 *
 * `detectMonoFontFamily()` caches its stack, so the value assigned after the font loads is the
 * SAME string the constructor already received: the guard swallows it, no measure runs, and the
 * cell keeps the fallback face's width. Moving the option through a different value first is what
 * makes the change observable. Both assignments happen in one task, so no frame ever paints the
 * intermediate face.
 */
export function forceFontFamilyRemeasure(
  setFontFamily: (family: string) => void,
  resolveFamily: () => string = resolveCanvasTerminalFontFamily,
): void {
  const family = resolveFamily();
  // Never pick a nudge equal to the value about to be set — on a machine where nothing resolves,
  // the stack can collapse to a bare generic and the guard would swallow both writes.
  setFontFamily(family === "monospace" ? "serif" : "monospace");
  setFontFamily(family);
}

export type CanvasTerminalRemeasureResult =
  | "already-loaded"
  | "remeasured"
  | "disposed"
  | "font-api-failed";

export interface RemeasureTerminalAfterFontLoadDeps {
  isPrimaryFontLoaded: () => boolean;
  fontsReady: () => Promise<void>;
  isDisposed: () => boolean;
  reapplyFontFamily: () => void;
  refit: () => void;
}

/**
 * fontsource ships font-display: swap, so a terminal constructed on the very first frame
 * measures its glyph cell against the fallback (e.g. Menlo) and keeps that width until something
 * forces a re-measure. This re-measures once the real face is resident, but skips the whole
 * dance if xterm's constructor already measured the correct face.
 */
export async function remeasureTerminalAfterFontLoad(
  deps: RemeasureTerminalAfterFontLoadDeps,
): Promise<CanvasTerminalRemeasureResult> {
  if (deps.isPrimaryFontLoaded()) return "already-loaded";

  try {
    await deps.fontsReady();
  } catch {
    // document.fonts.ready can reject in a WKWebView mid-teardown; the terminal stays usable on
    // its fallback metrics rather than surfacing an unhandled rejection.
    return "font-api-failed";
  }

  if (deps.isDisposed()) return "disposed";

  // Order matters: refit() measures xterm's glyph cell against whatever fontFamily is currently
  // set, so the family swap must land before the refit or it measures the stale fallback again.
  deps.reapplyFontFamily();
  deps.refit();
  return "remeasured";
}
