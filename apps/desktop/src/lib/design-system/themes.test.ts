import { describe, expect, it } from "vitest";
import { contrastRatio, DESIGN_THEMES, getDesignThemeCssVars } from "@/lib/design-system";

const RAMP_STEPS = ["canvas", "bg", "surface", "raised", "overlay", "hairline"] as const;

function channels(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

describe("dark surface ramp", () => {
  const ramp = DESIGN_THEMES.dark.ramp;

  it("has six steps, each lighter than the one below it", () => {
    expect(Object.keys(ramp)).toEqual([...RAMP_STEPS]);
    for (let i = 1; i < RAMP_STEPS.length; i += 1) {
      const lower = ramp[RAMP_STEPS[i - 1]];
      const upper = ramp[RAMP_STEPS[i]];
      // Lighter in luminance, and far enough apart to tell side by side. Near black a visible step
      // is a small WCAG ratio: the canvas → bg step is ~1.06.
      expect(contrastRatio(upper, lower)).toBeGreaterThan(1.05);
      expect(channels(upper)[1]).toBeGreaterThan(channels(lower)[1]);
    }
  });

  it("is one warm hue: red over green over blue on every step, with a near-neutral spread", () => {
    for (const step of RAMP_STEPS) {
      const [r, g, b] = channels(ramp[step]);
      expect(r).toBeGreaterThanOrEqual(g);
      expect(g).toBeGreaterThan(b);
      expect(r - b).toBeLessThanOrEqual(8);
    }
  });

  it("is what the app paints for background, sidebar, cards and popovers", () => {
    const vars = getDesignThemeCssVars(DESIGN_THEMES.dark);
    expect(vars["--bg-sidebar"]).toBe(ramp.canvas);
    expect(vars["--ds-bg"]).toBe(ramp.bg);
    expect(vars["--ds-surface"]).toBe(ramp.surface);
    expect(vars["--ds-surface-raised"]).toBe(ramp.raised);
    expect(vars["--ds-workbench-popover-bg"]).toBe(ramp.overlay);
  });
});

describe("light surfaces", () => {
  const vars = getDesignThemeCssVars(DESIGN_THEMES.light);

  it("sets the page off-white and the card white, so a card lifts without its border", () => {
    expect(vars["--ds-surface"]).toBe("#ffffff");
    expect(vars["--ds-bg"]).not.toBe(vars["--ds-surface"]);
    expect(contrastRatio(vars["--ds-surface"], vars["--ds-bg"])).toBeGreaterThan(1.05);
  });

  it("draws every border and shadow in one warm tint, never black", () => {
    const painted = [
      vars["--ds-border"],
      vars["--ds-border-subtle"],
      vars["--ds-workbench-popover-border"],
      vars["--ds-shadow-edge"],
      vars["--ds-shadow-soft"],
      vars["--ds-shadow-lift"],
      vars["--ds-workbench-shadow-edge"],
      vars["--ds-workbench-shadow-soft"],
      vars["--ds-workbench-shadow-lift"],
      vars["--ds-workbench-popover-shadow"],
    ].join(" ");
    const tints = new Set([...painted.matchAll(/rgba\((\d+,\d+,\d+),/g)].map((m) => m[1]));
    expect(tints.size).toBe(1);
    const [r, g, b] = [...tints][0].split(",").map(Number);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});

describe("popover elevation", () => {
  /**
   * Menus, popovers and tooltips are elevation 3 (mockup 10, T7): the overlay step, the popover
   * border and a two-layer shadow, with no blur. The shadow is one token, so every floating surface
   * in the app lifts by the same amount in each mode.
   */
  it.each(["dark", "light"] as const)("gives %s floating surfaces a two-layer shadow", (mode) => {
    const shadow = getDesignThemeCssVars(DESIGN_THEMES[mode])["--ds-workbench-popover-shadow"];
    expect(shadow).toBeDefined();
    const layers = shadow.split(/,(?![^(]*\))/);
    expect(layers).toHaveLength(2);
    expect(shadow).not.toContain("inset");
  });
});
