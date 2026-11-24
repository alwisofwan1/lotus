import { describe, expect, it } from "vitest";
import { resolveS2sActivityHint } from "../s2s-activity-hint";

describe("resolveS2sActivityHint", () => {
  it("replaces generic thinking copy with the actual turn phase", () => {
    expect(resolveS2sActivityHint({
      fallback: "Thinking…",
      phase: "thinking",
      tools: "idle",
    })).toBe("Finishing your turn…");
  });

  it("shows handoff preparation while dispatch is running", () => {
    expect(resolveS2sActivityHint({
      fallback: "Thinking…",
      phase: "thinking",
      tools: "running",
      lastTool: "dispatch",
    })).toBe("Preparing handoff…");
  });

  it("shows response preparation after a tool has settled", () => {
    expect(resolveS2sActivityHint({
      fallback: "Thinking…",
      phase: "thinking",
      tools: "ok",
      lastTool: "dispatch",
    })).toBe("Preparing response…");
  });

  it("preserves the existing hint outside the thinking phase", () => {
    expect(resolveS2sActivityHint({
      fallback: "Listening — talk naturally",
      phase: "listening",
      tools: "ok",
      lastTool: "dispatch",
    })).toBe("Listening — talk naturally");
  });
});
