import { describe, expect, it } from "vitest";
import {
  DEFAULT_S2S_SETTINGS,
  resolveS2sEngagement,
  type S2sReadiness,
} from "../s2s-mode";

const provider = (over: Partial<S2sReadiness> = {}): S2sReadiness => ({
  id: "grok",
  enabled: true,
  ...over,
});

describe("resolveS2sEngagement", () => {
  it("is disabled by default so the classic turn-based voice path runs unchanged", () => {
    const out = resolveS2sEngagement(DEFAULT_S2S_SETTINGS, [provider()]);
    expect(out.engage).toBe(false);
  });

  it("engages when enabled with a usable provider selected", () => {
    const out = resolveS2sEngagement({ enabled: true, providerId: "grok" }, [provider()]);
    expect(out).toEqual({ engage: true, providerId: "grok" });
  });

  it("stays off when enabled but no provider is selected", () => {
    const out = resolveS2sEngagement({ enabled: true, providerId: null }, [provider()]);
    expect(out).toEqual({ engage: false, reason: "no-provider" });
  });

  it("stays off when the selected provider is missing or disabled (falls back to legacy path)", () => {
    const missing = resolveS2sEngagement({ enabled: true, providerId: "ghost" }, [provider()]);
    expect(missing).toEqual({ engage: false, reason: "no-provider" });
    const disabled = resolveS2sEngagement({ enabled: true, providerId: "grok" }, [
      provider({ enabled: false }),
    ]);
    expect(disabled).toEqual({ engage: false, reason: "no-provider" });
  });

  it("reports the disabled reason when the master toggle is off", () => {
    const out = resolveS2sEngagement({ enabled: false, providerId: "grok" }, [provider()]);
    expect(out).toEqual({ engage: false, reason: "disabled" });
  });
});
