/**
 * Colour arithmetic for the design-system palettes: the `alpha()` notation the palettes are
 * written in, and the WCAG 2.x contrast maths the contrast tests measure them with.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` or `transparent` as channels 0–255 and alpha 0–1. */
export function parseColor(color: string): Rgba {
  if (color.trim().toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    const channel = (index: number) => parseInt(digits.slice(index * 2, index * 2 + 2), 16);
    return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? channel(3) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    color.trim(),
  );
  if (fn) {
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  }
  throw new Error(`Unsupported colour "${color}" — use hex, rgb(), rgba() or transparent`);
}

function toHex({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * `#rrggbb` for an OKLCH colour (lightness 0–1, chroma, hue in degrees). The palettes are designed in
 * OKLCH so one hue and a lightness ramp can be read straight off the source; a colour sRGB cannot
 * show throws rather than being clipped into a different hue (a rounding sliver past the edge is allowed).
 */
export function oklch(lightness: number, chroma: number, hue: number): string {
  const h = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  if (linear.some((c) => c < -2e-3 || c > 1 + 2e-3)) {
    throw new Error(`oklch(${lightness} ${chroma} ${hue}) is outside sRGB`);
  }
  const encode = (c: number) => {
    const v = Math.min(1, Math.max(0, c));
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  };
  const [r, g, bl] = linear.map(encode);
  return toHex({ r, g, b: bl, a: 1 });
}

/** `#rrggbb` at the given opacity, as the `rgba()` string the CSS variables carry. */
export function alpha(hex: string, opacity: number): string {
  const { r, g, b } = parseColor(hex);
  return `rgba(${r},${g},${b},${opacity})`;
}

function blend(fg: Rgba, bg: Rgba): Rgba {
  const mix = (f: number, b: number) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** The opaque colour `top` shows as when painted over an opaque `backdrop`. */
export function compositeOver(top: string, backdrop: string): string {
  const bg = parseColor(backdrop);
  if (bg.a !== 1) throw new Error(`Backdrop "${backdrop}" must be opaque`);
  return toHex(blend(parseColor(top), bg));
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * WCAG 2.x contrast ratio (1–21) of `foreground` on `surface`. A translucent foreground is blended
 * into the surface first, the way the browser paints it; the surface itself must be opaque —
 * flatten a translucent one onto whatever sits under it with `compositeOver` first.
 */
export function contrastRatio(foreground: string, surface: string): number {
  const bg = parseColor(surface);
  if (bg.a !== 1) {
    throw new Error(`Surface "${surface}" must be opaque; compositeOver() it onto its backdrop first`);
  }
  const a = relativeLuminance(blend(parseColor(foreground), bg));
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
