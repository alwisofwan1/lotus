import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "./builtin-themes";
import { resolveTerminalFloor } from "./terminal-floor";

/**
 * The Note body paints an OPAQUE floor (`--note-paper` in note-node.css, derived from
 * `--node-floor-solid`) instead of the shared translucent `--node-scrim`.
 *
 * Why this test exists: the scrim was measured against a photo wallpaper at ~14% transmittance,
 * and because a resting node runs with `backdrop-filter: none`, that leak arrives sharp — the
 * wallpaper's own edges compete with 13px body text. Swapping in the opaque floor removes the
 * wallpaper from the contrast equation entirely, which is only an improvement if the floor itself
 * carries the ink ramp on EVERY theme. That is what is asserted here, so a future theme (or a
 * change to the floor resolver) cannot quietly make note text unreadable.
 *
 * The ink ramp is `color-mix(in oklab, var(--canvas-text) N%, transparent)` composited over the
 * floor. sRGB compositing is used below; the CSS mix is oklab, but this is a legibility floor
 * check with generous headroom, not a colour-accuracy check.
 */

type Rgb = [number, number, number];

function parseColor(value: string): Rgb {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const short = value.trim().match(/^#([0-9a-f]{3})$/i);
  if (short) {
    const [r, g, b] = short[1].split("").map((c) => parseInt(c + c, 16));
    return [r, g, b];
  }
  const fn = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  throw new Error(`unsupported colour: ${value}`);
}

/** Composite `fg` at `alpha` over an opaque `bg` — what the ink ramp does over the paper. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The ink steps note-node.css actually uses for text, with their WCAG target.
 *
 * The two low steps carry a second alpha, because note-node.css now has a
 * `[data-canvas-mode="light"]` branch that raises them. Alpha compositing is linear in sRGB but
 * luminance is not, so a dark wash on light paper loses contrast faster than a light wash on dark
 * paper: at 42% Garden of Dawn measures 2.40:1 where Void measures 3.79:1. This table is the mirror
 * of that branch — change one and the other has to move with it.
 */
const TEXT_STEPS = [
  { token: "--note-ink-96", alpha: 0.96, role: "h1", min: 4.5 },
  { token: "--note-ink-90", alpha: 0.9, role: "h2 / edit-mode body", min: 4.5 },
  { token: "--note-ink-78", alpha: 0.78, role: "read-mode body", min: 4.5 },
  { token: "--note-ink-58", alpha: 0.58, light: 0.7, role: "hover-state chrome", min: 3 },
  { token: "--note-ink-42", alpha: 0.42, light: 0.52, role: "meta slot / muted", min: 3 },
];

describe("note paper floor legibility", () => {
  for (const theme of BUILTIN_THEMES) {
    describe(theme.name, () => {
      const floor = parseColor(resolveTerminalFloor(theme).background);
      const text = parseColor(theme.surface.text);

      it("resolves an opaque floor (no alpha channel to let the wallpaper through)", () => {
        expect(resolveTerminalFloor(theme).background).toMatch(/^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/);
      });

      for (const step of TEXT_STEPS) {
        const alpha = (theme.mode === "light" && step.light) || step.alpha;
        it(`carries ${step.token} (${step.role}) at >= ${step.min}:1`, () => {
          const ratio = contrast(over(text, alpha, floor), floor);
          expect(ratio).toBeGreaterThanOrEqual(step.min);
        });
      }

      it("keeps the read|edit chip's own ink legible on the chip fill", () => {
        // Two recipes, mirroring note-node.css. Dark themes have a BRIGHT note accent, so the
        // chip is a light fill with near-black ink:
        //   --note-chip-fill: accent 86% + #fffaf0 ; --note-chip-ink: accent 20% + #120c02
        // A light theme's note accent has to be dark to carry as text on paper, which inverts
        // the whole chip — the same relationship, read the other way round:
        //   --note-chip-fill: accent 88% + #120c02 ; --note-chip-ink: accent 14% + #fffaf0
        const accent = parseColor(theme.palette.note);
        const [fill, ink] =
          theme.mode === "light"
            ? [over(accent, 0.88, parseColor("#120c02")), over(accent, 0.14, parseColor("#fffaf0"))]
            : [over(accent, 0.86, parseColor("#fffaf0")), over(accent, 0.2, parseColor("#120c02"))];
        expect(contrast(ink, fill)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});
