import { describe, expect, it } from "vitest";

import { HOSTED_PANE_OVERLAY_BELOW, NAV_DRAWER_BELOW, PANE_OVERLAY_BELOW, surfaceFit } from "../surface-fit";

describe("surfaceFit", () => {
  it("keeps all three columns side by side before the surface is measured", () => {
    expect(surfaceFit(0)).toEqual({ nav: "inline", pane: "inline" });
    expect(surfaceFit(Number.NaN)).toEqual({ nav: "inline", pane: "inline" });
  });

  it("puts the pane over the feed first, then makes the sidebar a drawer", () => {
    expect(surfaceFit(PANE_OVERLAY_BELOW)).toEqual({ nav: "inline", pane: "inline" });
    expect(surfaceFit(PANE_OVERLAY_BELOW - 1)).toEqual({ nav: "inline", pane: "overlay" });
    expect(surfaceFit(NAV_DRAWER_BELOW - 1)).toEqual({ nav: "drawer", pane: "overlay" });
  });

  it("gives way in that order: the pane overlays before the sidebar folds", () => {
    expect(NAV_DRAWER_BELOW).toBeLessThan(PANE_OVERLAY_BELOW);
  });

  it("never folds a sidebar the host draws, and gives the pane the sidebar's room", () => {
    expect(surfaceFit(0, { hostedNav: true })).toEqual({ nav: "host", pane: "inline" });
    expect(surfaceFit(HOSTED_PANE_OVERLAY_BELOW, { hostedNav: true })).toEqual({ nav: "host", pane: "inline" });
    expect(surfaceFit(HOSTED_PANE_OVERLAY_BELOW - 1, { hostedNav: true })).toEqual({ nav: "host", pane: "overlay" });
    expect(surfaceFit(300, { hostedNav: true }).nav).toBe("host");
    expect(HOSTED_PANE_OVERLAY_BELOW).toBeLessThan(PANE_OVERLAY_BELOW);
  });
});
