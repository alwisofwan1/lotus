import { describe, expect, it } from "vitest";
import { resolveTerminalV2SurfacePolicy } from "../terminal-v2-surface-policy";

describe("Terminal V2 surface policy", () => {
  it("allows panes when the feature and runtime are active", () => {
    expect(resolveTerminalV2SurfacePolicy({
      featureEnabled: true,
      runtimeActive: true,
    })).toEqual({ useV2: true, reason: "eligible" });
  });

  it("falls back when the feature is disabled", () => {
    expect(resolveTerminalV2SurfacePolicy({
      featureEnabled: false,
      runtimeActive: true,
    })).toEqual({ useV2: false, reason: "feature-disabled" });
  });

  it("falls back before the app-level runtime is active", () => {
    expect(resolveTerminalV2SurfacePolicy({
      featureEnabled: true,
      runtimeActive: false,
    })).toEqual({ useV2: false, reason: "runtime-inactive" });
  });
});
