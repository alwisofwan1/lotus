import { compositeOver, contrastRatio, parseColor, type Rgba } from "@/lib/design-system/color";
import type { AppTheme } from "@/lib/design-system";

export const LOTUS_EDITOR_DARK_THEME = "lotus-dark";
export const LOTUS_EDITOR_LIGHT_THEME = "lotus-light";

/** Syntax text must read as body text against the editor background (WCAG AA). */
export const LOTUS_SYNTAX_MIN_CONTRAST = 4.5;
// Line numbers are a guide, not content: dimmer than code, still distinguishable.
const LINE_NUMBER_MIN_CONTRAST = 3;

export function isLotusEditorTheme(name: string): boolean {
  return name === LOTUS_EDITOR_DARK_THEME || name === LOTUS_EDITOR_LIGHT_THEME;
}

export type LotusEditorThemeRule = {
  scope: string | string[];
  settings: { foreground?: string; fontStyle?: string };
};

export type LotusEditorTheme = {
  name: string;
  type: "dark" | "light";
  colors: Record<string, string>;
  tokenColors: LotusEditorThemeRule[];
};

function byte(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
}

/** Monaco's theme colours are hex only: an `rgba()` from the app palette is dropped silently. */
function toHex({ r, g, b, a }: Rgba): string {
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ""}`;
}

function mix(from: Rgba, to: Rgba, amount: number): Rgba {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
    a: 1,
  };
}

/**
 * The palette colour as is when it already reads against `background`; otherwise moved toward the
 * editor foreground, a step at a time, just until it does. A palette polished later keeps its hue
 * wherever it can and never ships an unreadable token.
 */
function readable(color: string, background: string, foreground: string, minimum: number): string {
  const bg = compositeOver(background, "#000000");
  const start = parseColor(compositeOver(color, bg));
  const target = parseColor(compositeOver(foreground, bg));
  for (let step = 0; step <= 20; step += 1) {
    const candidate = toHex(mix(start, target, step / 20));
    if (contrastRatio(candidate, bg) >= minimum) return candidate;
  }
  return toHex(target);
}

/**
 * The CodeSpace editor's own theme, in the Shiki theme shape, made from the app theme the terminal
 * is drawn with: same text, cursor and selection, and syntax in the terminal's ANSI colours. The
 * ground is the app background, not the terminal's: only the terminal is the deeper well (mockup
 * T5), and every colour is re-solved against that ground. The palettes are fixed, so monaco-theme
 * builds each mode once.
 */
export function buildLotusEditorTheme(theme: AppTheme): LotusEditorTheme {
  const t = theme.terminal;
  const background = compositeOver(theme.ui.background, "#000000");
  const foreground = readable(t.foreground, background, theme.type === "light" ? "#000000" : "#ffffff", LOTUS_SYNTAX_MIN_CONTRAST);
  const fg = parseColor(foreground);
  const syntax = (color: string) => readable(color, background, foreground, LOTUS_SYNTAX_MIN_CONTRAST);
  const tint = (alpha: number) => toHex({ ...fg, a: alpha });

  const colors: Record<string, string> = {
    "editor.background": background,
    "editor.foreground": foreground,
    "editorCursor.foreground": toHex(parseColor(t.cursor)),
    "editor.selectionBackground": toHex(parseColor(t.selectionBackground)),
    "editor.inactiveSelectionBackground": tint(0.07),
    "editor.lineHighlightBackground": tint(0.035),
    "editor.lineHighlightBorder": "#00000000",
    "editorGutter.background": background,
    "editorLineNumber.foreground": readable(t.brightBlack, background, foreground, LINE_NUMBER_MIN_CONTRAST),
    "editorLineNumber.activeForeground": foreground,
    "editorIndentGuide.background1": tint(0.07),
    "editorIndentGuide.activeBackground1": tint(0.18),
    "editorWhitespace.foreground": tint(0.16),
    "editorBracketMatch.background": tint(0.08),
    "editorBracketMatch.border": tint(0.22),
    "editor.findMatchBackground": toHex({ ...parseColor(t.yellow), a: 0.32 }),
    "editor.findMatchHighlightBackground": toHex({ ...parseColor(t.yellow), a: 0.16 }),
    "editorWidget.background": compositeOver(theme.ui.backgroundElevated, background),
    "editorWidget.border": toHex(parseColor(theme.ui.border)),
    "scrollbarSlider.background": tint(0.1),
    "scrollbarSlider.hoverBackground": tint(0.16),
    "scrollbarSlider.activeBackground": tint(0.22),
  };

  const rule = (scope: string | string[], color: string, fontStyle?: string): LotusEditorThemeRule => ({
    scope,
    settings: { foreground: color, ...(fontStyle ? { fontStyle } : {}) },
  });

  const tokenColors: LotusEditorThemeRule[] = [
    rule(["comment", "punctuation.definition.comment"], syntax(t.brightBlack), "italic"),
    rule(["variable", "variable.other", "meta.definition.variable"], foreground),
    rule(["punctuation", "keyword.operator", "meta.brace"], syntax(t.white)),
    rule(["keyword", "storage", "storage.type", "storage.modifier", "keyword.control"], syntax(t.magenta)),
    rule(["string", "punctuation.definition.string", "markup.inline.raw"], syntax(t.green)),
    rule(["string.regexp", "constant.character.escape"], syntax(t.cyan)),
    rule(["constant.numeric", "constant.language", "constant.other", "support.constant"], syntax(t.yellow)),
    rule(["entity.name.function", "support.function", "meta.function-call"], syntax(t.blue)),
    rule(["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"], syntax(t.cyan)),
    rule(["entity.name.tag", "meta.tag.sgml"], syntax(t.red)),
    rule(["entity.other.attribute-name", "support.type.property-name", "meta.object-literal.key"], syntax(t.yellow)),
    rule(["variable.parameter"], syntax(t.brightWhite)),
    rule(["markup.heading", "entity.name.section"], syntax(t.blue), "bold"),
    rule(["markup.bold"], foreground, "bold"),
    rule(["markup.italic"], foreground, "italic"),
    rule(["markup.underline.link", "string.other.link"], syntax(t.cyan), "underline"),
    rule(["markup.inserted"], syntax(t.green)),
    rule(["markup.deleted", "invalid"], syntax(t.red)),
  ];

  return {
    name: theme.type === "light" ? LOTUS_EDITOR_LIGHT_THEME : LOTUS_EDITOR_DARK_THEME,
    type: theme.type,
    colors,
    tokenColors,
  };
}
