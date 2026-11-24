// The opaque floor a canvas terminal paints its cells on (plans/canvas-terminal-opaque-floor).
//
// WHY IT IS RESOLVED IN JS AND NOT IN CSS
// xterm cannot read CSS custom properties — `theme.background` has to be a literal colour.
// And the CSS viewport underneath must carry the SAME literal, or the node shows a seam where
// xterm's background meets the viewport's. One resolver, consumed by both, is the only way the
// two can't drift.
//
// It also sidesteps a trap already documented at node-shell.css:198: `paper.fill` is a GRADIENT
// on four of the five builtins, and `color-mix()` with a gradient is invalid — the whole
// declaration collapses to transparent black. Flattening happens here, where a gradient is just
// a string to average.
//
// The mixing below is sRGB, while the CSS tokens it mirrors (--node-surface-ink, --node-surface)
// use oklab. On the builtin themes the two land within ~2/255 of each other, and it does not
// matter: nothing compares this value against the CSS mix. Both the terminal and its viewport
// consume THIS number, so it is self-consistent by construction.

import type { CanvasTheme } from "../../types/canvas-theme";

/** Opaque sRGB triple, 0-255, unrounded so the maths can chain without drift. */
type Rgb = readonly [number, number, number];

/** A colour plus its alpha, as authored in a theme token. */
interface Layer {
  rgb: Rgb;
  alpha: number;
}

/** Last-resort floor: a dark neutral. A malformed theme must never black out a terminal. */
const FALLBACK_PAPER: Rgb = [8, 8, 12];

/** node-shell.css:205 — the ink the floor is tinted toward on dark themes. */
const DARK_INK: Rgb = [10, 13, 18];
/** node-shell.css:401 — light themes lift the ink toward paper white instead. */
const LIGHT_INK: Rgb = [255, 255, 255];

/**
 * A steadying dose of neutral ink, mixed into the theme's own backdrop before darkening.
 *
 * Small on purpose. Mixing toward ink is what KILLS chroma: an earlier model leaned on it at
 * 80% and every theme came out the same grey-black, which is the opposite of belonging to its
 * theme. Its only job here is to stop a violently saturated backdrop from reading as candy.
 */
const INK_STABILISER = 0.16;

/**
 * Luminance ceiling for the floor, out of 255. A CEILING, never a target.
 *
 * Normalising every theme UP to the same lightness was tried and rejected: Void's paper is
 * `#050506`, so scaling it threefold amplified its faint blue cast into teal and "deep space
 * ink" stopped being ink. A theme already darker than this is left exactly where it is.
 */
const LUMA_CEILING = 26;

/**
 * Light themes invert the rule: the ground must be a page, so this becomes a FLOOR.
 *
 * 232 until Crimson Zen, the first light built-in, made it measurable rather than hypothetical.
 * That wallpaper's own mist is luma 228.7, so a floor of 232 put the terminal ABOVE the scene it
 * sits in — the lightest thing on the whole canvas — which inverts figure and ground: the
 * terminal stopped being a sheet laid on the paper and became a hole punched through it.
 *
 * 225 lets a floor resolve to the scene's own paper instead, and costs nothing in legibility:
 * that theme's ink still measured 12.59:1 there, and its muted 5.20:1.
 *
 * Crimson Zen has since been replaced by Garden of Dawn, whose sampled colour is luma 232 and so
 * clears this on its own — the branch lifts it by nothing, and its ink and muted measure 12.59:1
 * and 5.21:1 on the untouched sampled colour. The constant is deliberately NOT raised back to
 * 232 on that account: 225 is the bar that survives a light theme whose own paper is darker, and
 * one such theme shipped here for two days.
 */
const LIGHT_LUMA_FLOOR = 225;

/** node-shell.css:205 — the ink is 74% base ink, 26% the theme's own surface. */
const INK_MIX = 0.74;

const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
const FUNCTIONAL = /\brgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/gi;

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function format(rgb: Rgb): string {
  return `rgb(${clampChannel(rgb[0])}, ${clampChannel(rgb[1])}, ${clampChannel(rgb[2])})`;
}

function fromHex(hex: string): Rgb {
  const body = hex.replace("#", "");
  const full =
    body.length === 3
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Every colour a CSS colour-ish string mentions, in source order.
 * Gradient geometry (`180deg`, `ellipse at 55% 18%`, stop positions) carries no `#` and no
 * `rgb(` and so cannot leak in — that invariant is pinned by a test.
 */
function extractColors(value: string): Layer[] {
  const out: Layer[] = [];
  for (const m of value.matchAll(HEX)) out.push({ rgb: fromHex(m[0]), alpha: 1 });
  for (const m of value.matchAll(FUNCTIONAL)) {
    out.push({
      rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
      alpha: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return out;
}

/** Parse a single authored token (`#123`, `rgb(…)`, `rgba(…)`) into a layer. */
function parseLayer(value: string, fallback: Layer): Layer {
  return extractColors(value)[0] ?? fallback;
}

/** Paint `over` on top of opaque `base`. */
function composite(over: Layer, base: Rgb): Rgb {
  const a = Math.min(1, Math.max(0, over.alpha));
  return [
    over.rgb[0] * a + base[0] * (1 - a),
    over.rgb[1] * a + base[1] * (1 - a),
    over.rgb[2] * a + base[2] * (1 - a),
  ];
}

/** Blend two opaque colours, `ratio` being the weight of the first. */
function mix(a: Rgb, b: Rgb, ratio: number): Rgb {
  return [
    a[0] * ratio + b[0] * (1 - ratio),
    a[1] * ratio + b[1] * (1 - ratio),
    a[2] * ratio + b[2] * (1 - ratio),
  ];
}

/**
 * One opaque colour standing in for a theme's whole backdrop.
 *
 * A flat fill passes straight through; a gradient averages its stops. That average is the only
 * honest answer a single colour can give: once a photo wallpaper is involved, no constant can
 * match every node position, which is precisely the trade-off the opaque floor accepts.
 */
export function flattenPaperBase(fill: string): string {
  const colors = extractColors(fill ?? "");
  if (colors.length === 0) return format(FALLBACK_PAPER);
  const sum = colors.reduce<Rgb>(
    (acc, c) => [acc[0] + c.rgb[0], acc[1] + c.rgb[1], acc[2] + c.rgb[2]],
    [0, 0, 0],
  );
  return format([sum[0] / colors.length, sum[1] / colors.length, sum[2] / colors.length]);
}

export interface TerminalFloor {
  /**
   * Always false. An opaque floor is the whole point: it lets the DOM renderer take its
   * background-run fast path and lets the WebGL renderer skip per-cell alpha blending.
   */
  allowTransparency: false;
  /** Literal `rgb(r, g, b)` for xterm's `theme.background` and the CSS viewport alike. */
  background: string;
}

// The glass rim that photo-backed themes keep around the opaque core is NOT decided here. It is
// a pure presentation rule and CSS already carries both signals it needs on the canvas root —
// `[data-canvas-material="glass"][data-canvas-paper-media]` (CanvasPage.tsx). Re-deriving it into
// a custom property would have given CSS a value it cannot branch on without style queries.
// See terminal-node.css and canvas-terminal-floor.css.test.ts.

/** Perceived lightness, 0-255. Cheap and gamma-naive on purpose: this picks a colour, not a
 *  contrast verdict. The contrast contract is asserted in the test suite against real WCAG. */
function luma(rgb: Rgb): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/**
 * Scale a colour toward black until it sits under `ceiling`, keeping the ratio between channels.
 *
 * Scaling all three channels by one factor is what preserves hue and saturation — the reason a
 * darkened Lakeside Day stays green instead of drifting to grey. A colour already below the
 * ceiling is returned untouched.
 */
function darkenTo(rgb: Rgb, ceiling: number): Rgb {
  const y = luma(rgb) || 1;
  const scale = Math.min(1, ceiling / y);
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
}

/** The colour that stands for the theme's backdrop, before it is darkened into a floor. */
function themeCharacter(theme: CanvasTheme): Rgb {
  // A photograph beats the hand-drawn stand-in. See CanvasPaper.sampled: Lakeside Day's fill is
  // pure blue while 46% of its wallpaper is foliage, so a fill-derived floor reads as foreign
  // on top of the actual image.
  const sampled = theme.paper.sampled ? extractColors(theme.paper.sampled)[0] : undefined;
  if (sampled) return sampled.rgb;

  const paperBase = extractColors(flattenPaperBase(theme.paper.fill))[0]?.rgb ?? FALLBACK_PAPER;

  // theme.css:197-199 — solid and grain materials have no glass panel; the node body is
  // --canvas-surface instead, with the backdrop-filter switched off.
  const panelToken =
    theme.material === "glass" && theme.glass ? theme.glass.bg : theme.surface.base;
  const panel = parseLayer(panelToken, { rgb: paperBase, alpha: 1 });
  const panelFlat = composite(panel, paperBase);

  // node-shell.css:205 — `rgb(from … r g b / 1)` strips the surface's own alpha before mixing,
  // so the ink is built from the surface COLOUR only.
  const surface = parseLayer(theme.surface.base, { rgb: paperBase, alpha: 1 });
  const ink = mix(DARK_INK, surface.rgb, INK_MIX);

  return mix(panelFlat, ink, 1 - INK_STABILISER);
}

/** Resolve the floor a canvas terminal should paint on for the active theme. */
export function resolveTerminalFloor(theme: CanvasTheme): TerminalFloor {
  const character = themeCharacter(theme);

  if (theme.mode === "light") {
    // Light themes need an opaque page for dark ink, so the rule inverts: guarantee a MINIMUM
    // lightness instead of a maximum, lifting toward paper white only as far as that takes.
    // Lerping the remaining distance keeps the hue, the same way darkenTo does going the other
    // way — and, like darkenTo, a theme already past the threshold is left exactly where it is.
    //
    // It used to pre-mix 88% pure white into the character before measuring (LIGHT_PAPER_WEIGHT).
    // That assumed `character` was dark, which held only while no builtin was light. Crimson Zen
    // arrived measuring rgb(236,227,224), and the pre-mix returned rgb(253,252,251): the warm
    // cast gone, a faintly cold white rectangle sitting on warm paper. The dark branch never had
    // the equivalent bug precisely because it has no such pre-mix. Now neither does this one.
    const y = luma(character);
    const toWhite = y >= LIGHT_LUMA_FLOOR ? 0 : (LIGHT_LUMA_FLOOR - y) / Math.max(1, 255 - y);
    return { allowTransparency: false, background: format(mix(LIGHT_INK, character, toWhite)) };
  }

  return { allowTransparency: false, background: format(darkenTo(character, LUMA_CEILING)) };
}
