// CodeCanvas Artisan Theme Engine — the resolver.
// The SINGLE place a theme's token bag becomes CSS custom properties.
// Pure function: `resolveCanvasTheme(theme) → { "--canvas-…": value }`.
// See docs/adr/0023-codecanvas-artisan-theme-engine.md.

import {
  STATUS_TONES,
  TEXT_SIZE_REM,
  type CanvasStatusState,
  type CanvasTheme,
} from "../../types/canvas-theme";
import { resolveTerminalFloor } from "./terminal-floor";
import { FRAME_COLORS } from "../canvas-frame-palette";

/** A flat CSS-custom-property map: var name (incl. leading `--`) → value. */
export type CssVarMap = Record<string, string>;

/**
 * Apply an alpha channel to a `#rgb` / `#rrggbb` colour, yielding `rgba(...)`.
 * Non-hex input (e.g. an already-rgba string) is returned unchanged so the
 * resolver never throws on a hand-authored value.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function parseHex(color: string): { r: number; g: number; b: number } | null {
  const hex = color.trim().replace(/^#/, "");
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  return null;
}

function fontStack(family: string, fallback: string): string {
  return `"${family}", ${fallback}`;
}

/** WCAG relative luminance of an opaque colour. Non-hex input yields null. */
function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return 0;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The ink painted ON a filled accent surface — a segmented control's active pill, a primary
 * button, a badge.
 *
 * This has to be RESOLVED rather than authored, because `surface.chromeAccent` is the only
 * token whose lightness is free to sit anywhere: it is near-white on the dark built-ins and
 * dark on the light one, and a single literal is therefore wrong for half the catalog. The
 * app-global `--accent-fg` was that single literal (`#ffffff`), which is why an active pill
 * on a light theme rendered white-on-pale.
 *
 * Candidates in preference order, best contrast wins: the theme's OWN ink first, so a pill
 * belongs to its theme whenever that is legible at all, then the two extremes as a guaranteed
 * floor. `surface.text` only wins when it genuinely beats both, which on the built-in catalog
 * means it never does — but a future theme with a pale accent and near-black ink would take it,
 * and that is the case worth keeping the branch for.
 */
function accentInk(surfaceText: string, chromeAccent: string): string {
  const candidates = [surfaceText, "#ffffff", "#0b0b0f"];
  let best = candidates[0];
  let bestRatio = -1;
  for (const c of candidates) {
    const ratio = contrastRatio(c, chromeAccent);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = c;
    }
  }
  return best;
}

/**
 * Resolve a theme into the CSS variables consumed under `.codecanvas-shell`.
 *
 * Emits, regardless of theme:
 *   --canvas-bg / -surface / -surface-r / -text / -text-muted / -border / -border-str
 *   --canvas-accent / -focus-ring        (UI chrome accent)
 *   --canvas-wire{,-soft,-active,-node}   (derived from palette.accent)
 *   --canvas-node-{agent,task,note,info}  (palette roles)
 *   --canvas-status-{idle,…,blocked}      (theme-INDEPENDENT ramp)
 *   --canvas-font-{display,body,mono}
 *   --node-surface-style                  (the material)
 * Emits only for `material: "glass"`: the --node-glass-* / --panel-glass-* / --header-glass-grad set.
 * Emits only when the theme carries one: --canvas-node-text-size (theme default; user override layered later).
 */
export function resolveCanvasTheme(theme: CanvasTheme): CssVarMap {
  const { paper, surface, palette, fonts } = theme;

  const vars: CssVarMap = {
    // Canvas surface
    "--canvas-bg": paper.fill,
    "--canvas-surface": surface.base,
    "--canvas-surface-r": surface.raised,
    "--canvas-text": surface.text,
    "--canvas-text-muted": surface.textMuted,
    "--canvas-border": surface.border,
    "--canvas-border-str": surface.borderStrong,

    // UI chrome accent (buttons/focus) — distinct from the graph accent.
    // Focus ring derives at 0.22 to match the app's --ds-workbench-focus-ring (dark).
    "--canvas-accent": surface.chromeAccent,
    "--canvas-accent-fg": accentInk(surface.text, surface.chromeAccent),
    "--canvas-focus-ring": withAlpha(surface.chromeAccent, 0.22),

    // Wires/selection derive from the signature palette accent
    "--canvas-wire": withAlpha(palette.accent, 0.34),
    "--canvas-wire-soft": withAlpha(palette.accent, 0.18),
    "--canvas-wire-active": withAlpha(palette.accent, 0.82),
    "--canvas-wire-node": withAlpha(palette.accent, 0.42),

    // Per-node-type identity hues
    "--canvas-node-agent": palette.agent,
    "--canvas-node-task": palette.task,
    "--canvas-node-note": palette.note,
    "--canvas-node-info": palette.info,

    // Material
    "--node-surface-style": theme.material,

    // Fonts
    "--canvas-font-display": fontStack(fonts.display, "ui-rounded, system-ui, sans-serif"),
    "--canvas-font-body": fontStack(fonts.body, "system-ui, sans-serif"),
    "--canvas-font-mono": fontStack(fonts.mono, "ui-monospace, SFMono-Regular, monospace"),
  };

  // HUD face — emitted ONLY when the theme names one, unlike the three above. Every
  // consumer therefore reads `var(--canvas-font-hud, <its previous value>)`, so a theme
  // without a `hud` renders exactly as it did before the bucket existed. Setting a default
  // here instead would have silently repointed the badges on all five older builtins.
  if (fonts.hud) {
    vars["--canvas-font-hud"] = fontStack(fonts.hud, "ui-monospace, SFMono-Regular, monospace");
  }

  // Status ramp — always emitted, never theme-dependent (ADR-0023 §2b).
  for (const state of Object.keys(STATUS_TONES) as CanvasStatusState[]) {
    vars[`--canvas-status-${state}`] = STATUS_TONES[state];
  }

  // Frame colours (ADR-0050): a fixed named palette, also theme-independent and checked to stay
  // away from every status hue above.
  for (const c of FRAME_COLORS) vars[`--canvas-frame-${c.id}`] = c.hex;

  // Terminal floor — UNCONDITIONAL, unlike the glass block below. Every material needs an
  // opaque floor: xterm runs with allowTransparency:false so it can take the background-run
  // fast path, and it cannot read CSS variables, so the value has to be a literal colour.
  // The CSS viewport consumes this same token; resolving it once here is what stops xterm's
  // background and the viewport's from drifting into a visible seam. See terminal-floor.ts.
  const floor = resolveTerminalFloor(theme);
  vars["--node-floor-solid"] = floor.background;

  // Glass material carries structural + colour glass tokens.
  if (theme.material === "glass" && theme.glass) {
    const g = theme.glass;
    vars["--node-glass-bg"] = g.bg;
    vars["--node-glass-filter"] = g.filter;
    vars["--node-glass-border"] = g.border;
    vars["--node-glass-shadow"] = g.shadow;
    vars["--node-glass-inset"] = g.inset;
    vars["--header-glass-grad"] = g.headerGrad;
    vars["--panel-glass-bg"] = g.panelBg;
    vars["--panel-glass-filter"] = g.panelFilter;
  }

  // A theme may suggest a default node text size; the user override is layered
  // on top by the hook (Phase 1). Here we only emit the theme's own default.
  if (theme.defaultTextSize) {
    vars["--canvas-node-text-size"] = TEXT_SIZE_REM[theme.defaultTextSize];
  }

  return vars;
}
