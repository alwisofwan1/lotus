import type { CanvasShapeKind, CanvasShapeStyle } from "../types/canvas";

/**
 * Theme-aware default fill for freshly drawn shapes. A new container (rectangle/diamond/ellipse)
 * is born with a translucent tint of the active theme's accent — a glassy, premium surface that
 * matches whatever theme/wallpaper is live — instead of fully transparent. The color is STAMPED
 * at creation (persisted like any user-chosen fill), so a later theme switch never repaints
 * existing drawings; the Inspector clears or overrides it like any other background.
 */

/** Alpha of the stamped accent tint — bold enough to feel like a surface, still glassy. */
export const THEMED_FILL_ALPHA = 0.25;

const CONTAINER_KINDS = new Set<CanvasShapeKind>(["rectangle", "diamond", "ellipse"]);

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Parse #hex / rgb() / rgba() (incl. space-separated). Alpha is ignored — callers set their own. */
export function parseCssColor(input: string): RgbColor | null {
  const value = input.trim();
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(value);
  if (hex3) {
    const [r, g, b] = hex3[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(value);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
    if ([r, g, b].every((c) => c <= 255)) return { r, g, b };
  }
  return null;
}

/** The themed default style for a freshly drawn shape, or null (no fill) for non-containers
 *  and unparseable accents. */
export function themedShapeStyle(kind: CanvasShapeKind, accentColor: string): CanvasShapeStyle | null {
  if (!CONTAINER_KINDS.has(kind)) return null;
  const rgb = parseCssColor(accentColor);
  if (!rgb) return null;
  return { fill: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${THEMED_FILL_ALPHA})`, fillStyle: "solid" };
}

/**
 * Resolve the LIVE theme accent and derive the themed style. The accent token can be any CSS
 * color (hex, rgb, even color-mix), so it is resolved through a probe element's computed `color`
 * — the browser normalizes everything to rgb() — rather than read as raw custom-property text.
 */
export function liveThemedShapeStyle(kind: CanvasShapeKind): CanvasShapeStyle | null {
  if (!CONTAINER_KINDS.has(kind) || typeof document === "undefined") return null;
  const host = document.querySelector(".codecanvas-shell") ?? document.documentElement;
  const probe = document.createElement("span");
  probe.style.color = "var(--canvas-accent)";
  probe.style.display = "none";
  host.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return themedShapeStyle(kind, resolved);
}
