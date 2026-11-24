import { describe, expect, it } from "vitest";
import { ditherPixels } from "@/modules/workspace-shell/components/DitherStatus";

const radius = ({ x, y }: { x: number; y: number }) => Math.hypot(x - 5.5, y - 5.5);

describe("dither ring", () => {
  it("draws a ring with a fading tail while working: no centre, not every ring cell", () => {
    const pixels = ditherPixels(0.3, null);
    expect(pixels.length).toBeGreaterThan(10);
    expect(pixels.every((p) => radius(p) >= 3.6 && radius(p) <= 6)).toBe(true);
    const fullRing = ditherPixels(0, 150); // filled, not yet collapsing
    expect(pixels.length).toBeLessThan(fullRing.length);
  });

  it("turns: the lit cells move with the clock", () => {
    expect(ditherPixels(0, null)).not.toEqual(ditherPixels(0.4, null));
  });

  it("ends as a small solid dot in the centre", () => {
    const dot = ditherPixels(0, 700);
    expect(dot.length).toBeGreaterThan(0);
    expect(dot.every((p) => radius(p) <= 2.5)).toBe(true);
    expect(ditherPixels(9, 700)).toEqual(dot); // and stays put
  });
});
