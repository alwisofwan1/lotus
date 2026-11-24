import { describe, expect, it } from "vitest";
import {
  resolveTerminalV2PooledDomRendererPolicy,
} from "../terminal-v2-pooled-dom-renderer-policy";

describe("resolveTerminalV2PooledDomRendererPolicy", () => {
  it("allows development opt-in through the explicit storage value", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "development",
      storageValue: "1",
    })).toEqual({ enabled: true, reason: "enabled" });
  });

  it("enables development rollout through the feature flag by default", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "development",
      featureEnabled: true,
    })).toEqual({ enabled: true, reason: "enabled" });
  });

  it("does not enable the pooled DOM renderer in production from storage opt-in alone", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "production",
      storageValue: "1",
    })).toEqual({ enabled: false, reason: "production" });
  });

  it("enables production rollout through the feature flag", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "production",
      featureEnabled: true,
    })).toEqual({ enabled: true, reason: "enabled" });
  });

  it("keeps production disabled when the fallback switch is off", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "production",
      storageValue: "1",
      featureEnabled: false,
    })).toEqual({ enabled: false, reason: "disabled-by-flag" });
  });

  it("lets local storage emergency-disable production rollout", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "production",
      storageValue: "0",
      featureEnabled: true,
    })).toEqual({ enabled: false, reason: "not-enabled" });
  });

  it("keeps the pooled DOM renderer disabled when no rollout flag or storage opt-in is provided", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "development",
      storageValue: null,
    })).toEqual({ enabled: false, reason: "not-enabled" });
  });

  it("lets the feature flag act as the primary fallback switch", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "development",
      storageValue: "1",
      featureEnabled: false,
    })).toEqual({ enabled: false, reason: "disabled-by-flag" });
  });

  it("lets local storage disable the renderer for emergency diagnostics", () => {
    expect(resolveTerminalV2PooledDomRendererPolicy({
      environment: "development",
      storageValue: "0",
      featureEnabled: true,
    })).toEqual({ enabled: false, reason: "not-enabled" });
  });
});
