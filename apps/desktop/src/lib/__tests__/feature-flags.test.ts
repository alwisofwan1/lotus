import { describe, expect, it } from "vitest";
import {
  TERMINAL_RUNTIME_V2_FLAG,
  TERMINAL_V2_POOLED_DOM_RENDERER_FLAG,
  resolveFeatureFlag,
  resolveFeatureFlags,
  withFeatureFlag,
} from "../feature-flags";

describe("feature flags", () => {
  it("defaults Terminal V2 rollout flags on", () => {
    expect(resolveFeatureFlag(undefined, TERMINAL_RUNTIME_V2_FLAG)).toBe(true);
    expect(resolveFeatureFlag(undefined, TERMINAL_V2_POOLED_DOM_RENDERER_FLAG)).toBe(true);
    expect(resolveFeatureFlags(undefined).terminalRuntimeV2).toBe(true);
    expect(resolveFeatureFlags(undefined).terminalV2PooledDomRenderer).toBe(true);
  });

  it("honors explicit disabled settings", () => {
    expect(
      resolveFeatureFlag(
        { experimental: { terminalRuntimeV2: false } },
        TERMINAL_RUNTIME_V2_FLAG,
      ),
    ).toBe(false);
    expect(
      resolveFeatureFlag(
        { experimental: { terminalV2PooledDomRenderer: false } },
        TERMINAL_V2_POOLED_DOM_RENDERER_FLAG,
      ),
    ).toBe(false);
  });

  it("writes flags into the experimental namespace", () => {
    expect(
      withFeatureFlag(
        { experimental: { otherFlag: true } },
        TERMINAL_RUNTIME_V2_FLAG,
        false,
      ),
    ).toEqual({
      experimental: {
        otherFlag: true,
        terminalRuntimeV2: false,
      },
    });
  });
});
