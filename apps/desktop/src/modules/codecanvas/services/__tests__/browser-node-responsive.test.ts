import { describe, expect, it } from "vitest";
import {
  BROWSER_VIEWPORT_PRESETS,
  stepBrowserViewportZoom,
  resolveBrowserViewportProfile,
  rotateBrowserViewportProfile,
} from "../browser-node-responsive";

describe("browser node responsive viewport", () => {
  it("defaults a wide node to a desktop landscape profile", () => {
    expect(resolveBrowserViewportProfile({ mode: "auto", nodeWidth: 760, nodeHeight: 420 })).toMatchObject({
      mode: "auto",
      preset: "desktop",
      width: 1440,
      height: 900,
      orientation: "landscape",
      zoomFactor: 0.37,
    });
  });

  it("defaults a portrait node to a mobile profile", () => {
    expect(resolveBrowserViewportProfile({ mode: "auto", nodeWidth: 360, nodeHeight: 620 })).toMatchObject({
      mode: "auto",
      preset: "mobile",
      width: 390,
      height: 844,
      orientation: "portrait",
    });
  });

  it("uses explicit presets over auto aspect detection", () => {
    expect(resolveBrowserViewportProfile({ mode: "tablet", orientation: "landscape", nodeWidth: 360, nodeHeight: 620 })).toMatchObject({
      mode: "tablet",
      preset: "tablet",
      width: 1180,
      height: 820,
      orientation: "landscape",
    });
  });

  it("uses actual scale when requested", () => {
    expect(resolveBrowserViewportProfile({ mode: "desktop", scaleMode: "actual", nodeWidth: 760, nodeHeight: 420 })).toMatchObject({
      mode: "desktop",
      scaleMode: "actual",
      zoomFactor: 1,
    });
  });

  it("clamps manual zoom and steps it predictably", () => {
    const profile = resolveBrowserViewportProfile({
      mode: "desktop",
      viewportZoom: 0.76,
      nodeWidth: 760,
      nodeHeight: 420,
    });

    expect(profile.zoomFactor).toBe(0.76);
    expect(stepBrowserViewportZoom(profile, "in")).toBe(0.86);
    expect(stepBrowserViewportZoom(profile, "out")).toBe(0.66);
  });

  it("keeps custom dimensions sane and finite", () => {
    expect(resolveBrowserViewportProfile({
      mode: "custom",
      viewportWidth: 20000,
      viewportHeight: -1,
      nodeWidth: 640,
      nodeHeight: 420,
    })).toMatchObject({
      mode: "custom",
      preset: "custom",
      width: 2160,
      height: 900,
      orientation: "landscape",
    });
  });

  it("rotates a profile without changing its mode", () => {
    const mobile = resolveBrowserViewportProfile({ mode: "mobile" });
    expect(mobile).toMatchObject({
      width: BROWSER_VIEWPORT_PRESETS.mobile.width,
      height: BROWSER_VIEWPORT_PRESETS.mobile.height,
      orientation: "portrait",
    });
    expect(rotateBrowserViewportProfile(mobile)).toMatchObject({
      mode: "mobile",
      preset: "mobile",
      width: 844,
      height: 390,
      orientation: "landscape",
    });
  });
});
