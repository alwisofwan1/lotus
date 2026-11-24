import { describe, expect, it } from "vitest";

import { ORB_FRAMES, ORB_SIDE, cometPixels, orbFrame, orbTrack, pixelPath } from "../run-dither";

describe("orbFrame", () => {
  it("keeps every pixel inside the ring and moves the comet each frame", () => {
    const frames = Array.from({ length: ORB_FRAMES }, (_, i) => orbFrame(i));
    for (const frame of frames) {
      expect(frame.length).toBeGreaterThan(0);
      for (const [x, y] of frame) {
        const r = Math.hypot(x + 0.5 - ORB_SIDE / 2, y + 0.5 - ORB_SIDE / 2);
        expect(r).toBeLessThanOrEqual(ORB_SIDE / 2);
      }
    }
    const keys = frames.map((f) => JSON.stringify(f));
    expect(new Set(keys).size).toBe(ORB_FRAMES);
  });

  it("draws a track the comet runs over", () => {
    expect(orbTrack().length).toBeGreaterThan(0);
  });
});

describe("cometPixels", () => {
  it("is dense at its head and empty at its tail", () => {
    const on = cometPixels(40, 2);
    const head = on.filter(([x]) => x >= 36).length;
    const tail = on.filter(([x]) => x < 4).length;
    expect(head).toBeGreaterThan(tail);
    expect(on.some(([x]) => x === 0)).toBe(false);
    expect(on.filter(([x]) => x === 39)).toHaveLength(2);
  });
});

describe("pixelPath", () => {
  it("draws one unit square per pixel", () => {
    expect(pixelPath([[2, 1]])).toBe("M2 1h1v1h-1z");
  });
});
