import { describe, expect, it } from "vitest";
import { simplifyTrail } from "../canvas-freehand";

describe("simplifyTrail (Ramer–Douglas–Peucker)", () => {
  it("collapses collinear runs to their endpoints", () => {
    const trail = [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 50, y: 0 }, { x: 75, y: 0 }, { x: 100, y: 0 }];
    expect(simplifyTrail(trail, 1)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("keeps a genuine corner", () => {
    const trail = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 100 }];
    expect(simplifyTrail(trail, 1)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
  });

  it("smooths sensor noise below the tolerance but keeps real curvature above it", () => {
    const noisy = [{ x: 0, y: 0 }, { x: 25, y: 0.4 }, { x: 50, y: -0.3 }, { x: 75, y: 0.5 }, { x: 100, y: 0 }];
    expect(simplifyTrail(noisy, 1)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const curved = [{ x: 0, y: 0 }, { x: 50, y: 8 }, { x: 100, y: 0 }];
    expect(simplifyTrail(curved, 1)).toEqual(curved);
  });

  it("always preserves both endpoints", () => {
    const trail = [{ x: 3, y: 7 }, { x: 4, y: 7 }, { x: 5, y: 7 }];
    const out = simplifyTrail(trail, 10);
    expect(out[0]).toEqual({ x: 3, y: 7 });
    expect(out[out.length - 1]).toEqual({ x: 5, y: 7 });
  });

  it("returns short trails unchanged", () => {
    expect(simplifyTrail([], 1)).toEqual([]);
    expect(simplifyTrail([{ x: 1, y: 2 }], 1)).toEqual([{ x: 1, y: 2 }]);
    expect(simplifyTrail([{ x: 1, y: 2 }, { x: 3, y: 4 }], 1)).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  it("handles a closed loop (identical endpoints) without dropping the far side", () => {
    const loop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }];
    const out = simplifyTrail(loop, 1);
    expect(out.length).toBeGreaterThanOrEqual(4); // corners survive even with degenerate chord
  });
});
