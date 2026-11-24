import { describe, expect, it } from "vitest";
import { DITHER_FRONT, bayerTile, ditherTile } from "@/modules/factory/services/factory-dither";

describe("factory dither", () => {
  it("a Bayer tile lights exactly the asked share of its 16 pixels", () => {
    for (const n of [0, 3, 8, 16]) expect(bayerTile(n).on).toHaveLength(n);
  });

  it("the front thins from full to sparse, left to right", () => {
    const counts = DITHER_FRONT.map((t) => t.on.length);
    expect(counts[0]).toBe(16);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(new Set(counts).size).toBe(counts.length);
  });

  it("every status but the front has its own texture", () => {
    expect(ditherTile("active")).toBeNull();
    const shapes = (["done", "needs-you", "failed", "todo"] as const).map((s) => JSON.stringify(ditherTile(s)));
    expect(new Set(shapes).size).toBe(4);
  });
});
