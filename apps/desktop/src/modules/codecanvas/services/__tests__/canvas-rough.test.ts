import { describe, expect, it } from "vitest";
import { roughNodeOptions, roughSeedFromId, roughStyleSignature, strokeDashArray } from "../canvas-rough";

describe("strokeDashArray", () => {
  it("is undefined for solid / unset so the outline draws continuous", () => {
    expect(strokeDashArray("solid", 2)).toBeUndefined();
    expect(strokeDashArray(undefined, 2)).toBeUndefined();
  });

  it("produces distinct dashed vs dotted patterns", () => {
    expect(strokeDashArray("dashed", 2)).toBeTruthy();
    expect(strokeDashArray("dotted", 2)).toBeTruthy();
    expect(strokeDashArray("dashed", 2)).not.toBe(strokeDashArray("dotted", 2));
  });

  it("scales the pattern with stroke width", () => {
    expect(strokeDashArray("dashed", 4)).not.toBe(strokeDashArray("dashed", 1));
  });
});

describe("roughSeedFromId", () => {
  it("is deterministic per id, non-negative, and an integer (stable wobble across renders)", () => {
    expect(roughSeedFromId("node-a")).toBe(roughSeedFromId("node-a"));
    const seed = roughSeedFromId("node-a");
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(seed)).toBe(true);
  });

  it("differs across distinct ids", () => {
    expect(roughSeedFromId("node-a")).not.toBe(roughSeedFromId("node-b"));
  });
});

describe("roughNodeOptions", () => {
  it("maps sloppiness onto increasing roughness", () => {
    const architect = roughNodeOptions({ seed: 1, sloppiness: "architect" }).roughness ?? 0;
    const artist = roughNodeOptions({ seed: 1, sloppiness: "artist" }).roughness ?? 0;
    const cartoonist = roughNodeOptions({ seed: 1, sloppiness: "cartoonist" }).roughness ?? 0;
    expect(architect).toBeLessThan(artist);
    expect(artist).toBeLessThan(cartoonist);
  });

  it("defaults sloppiness to artist and passes seed/stroke/strokeWidth through", () => {
    const o = roughNodeOptions({ seed: 42, strokeColor: "#2b2733", strokeWidth: 2 });
    expect(o.seed).toBe(42);
    expect(o.stroke).toBe("#2b2733");
    expect(o.strokeWidth).toBe(2);
    expect(o.roughness).toBe(roughNodeOptions({ seed: 42, sloppiness: "artist" }).roughness);
  });

  it("normalizes unsafe stroke widths before handing them to rough.js", () => {
    expect(roughNodeOptions({ seed: 1, strokeWidth: 0 }).strokeWidth).toBeGreaterThanOrEqual(2);
    expect(roughNodeOptions({ seed: 1, strokeWidth: 999 }).strokeWidth).toBeLessThanOrEqual(12);
  });

  it("includes fill only when provided", () => {
    expect(roughNodeOptions({ seed: 1 }).fill).toBeUndefined();
    expect(roughNodeOptions({ seed: 1, fill: "#f7f5ef" }).fill).toBe("#f7f5ef");
  });

  it("defaults fillStyle to solid and honors an explicit texture when filled", () => {
    expect(roughNodeOptions({ seed: 1, fill: "#f7f5ef" }).fillStyle).toBe("solid");
    expect(roughNodeOptions({ seed: 1, fill: "#f7f5ef", fillStyle: "cross-hatch" }).fillStyle).toBe("cross-hatch");
  });

  it("excludes opacity from the rough signature so dragging it never regenerates paths", () => {
    expect(roughStyleSignature({ strokeColor: "#fff", opacity: 30 })).toBe(roughStyleSignature({ strokeColor: "#fff", opacity: 90 }));
    expect(roughStyleSignature(undefined)).toBe(roughStyleSignature({ opacity: 50 }));
  });

  it("changes the rough signature when a geometry-affecting field changes", () => {
    expect(roughStyleSignature({ strokeColor: "#fff" })).not.toBe(roughStyleSignature({ strokeColor: "#000" }));
    expect(roughStyleSignature({ fill: "#111", fillStyle: "hachure" })).not.toBe(roughStyleSignature({ fill: "#111", fillStyle: "cross-hatch" }));
    expect(roughStyleSignature({ strokeWidth: 1 })).not.toBe(roughStyleSignature({ strokeWidth: 2.5 }));
  });

  it("maps strokeStyle to a rough dash pattern (solid = none)", () => {
    expect(roughNodeOptions({ seed: 1 }).strokeLineDash).toBeUndefined();
    expect(roughNodeOptions({ seed: 1, strokeStyle: "solid" }).strokeLineDash).toBeUndefined();
    expect(roughNodeOptions({ seed: 1, strokeStyle: "dashed" }).strokeLineDash).toEqual([8, 8]);
    expect(roughNodeOptions({ seed: 1, strokeStyle: "dotted" }).strokeLineDash).toEqual([2, 6]);
  });
});
