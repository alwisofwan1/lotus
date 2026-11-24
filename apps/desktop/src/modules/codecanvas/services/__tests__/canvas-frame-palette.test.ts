import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FRAME_COLORS } from "../canvas-frame-palette";
import { STATUS_TONES } from "../../types/canvas-theme";

/** sRGB hex to OKLCH (Ottosson). Perceptual hue, so "30 degrees apart" means the same thing at every lightness. */
function oklch(hex: string): { c: number; h: number } {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d);
};
/** Below this chroma a colour reads as grey: it has no hue to confuse with a status. */
const NEUTRAL_CHROMA = 0.04;
const MIN_HUE_GAP = 30;

describe("Frame palette against the status ramp (decision 15, story 14)", () => {
  for (const color of FRAME_COLORS) {
    it(`${color.name} is not mistakable for a status colour`, () => {
      const mine = oklch(color.hex);
      if (mine.c < NEUTRAL_CHROMA) return; // Mist, Stone
      for (const [state, hex] of Object.entries(STATUS_TONES)) {
        const tone = oklch(hex);
        if (tone.c < NEUTRAL_CHROMA) continue; // idle is white
        expect(hueGap(mine.h, tone.h), `${color.name} vs ${state}`).toBeGreaterThanOrEqual(MIN_HUE_GAP);
      }
    });
  }

  it("keeps the six names, in order", () => {
    expect(FRAME_COLORS.map((c) => c.name)).toEqual(["Iris", "Moss", "Rose", "Orchid", "Mist", "Stone"]);
  });
});

describe("Frame palette has one source of truth", () => {
  it("styles/canvas/theme.css fallbacks equal the palette hexes", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/canvas/theme.css"), "utf8");
    for (const color of FRAME_COLORS) {
      const match = new RegExp(`--canvas-frame-${color.id}:\\s*var\\(--ct-canvas-frame-${color.id},\\s*(#[0-9a-fA-F]{6})\\)`).exec(css);
      expect(match, `theme.css declares --canvas-frame-${color.id}`).not.toBeNull();
      expect(match![1].toLowerCase()).toBe(color.hex.toLowerCase());
    }
  });
});
