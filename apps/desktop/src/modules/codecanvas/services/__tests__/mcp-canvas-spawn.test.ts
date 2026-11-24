import { describe, expect, it } from "vitest";
import { resolveMcpSpawnRunner } from "../mcp-canvas-spawn";

describe("resolveMcpSpawnRunner", () => {
  it("resolves a native runner from the override or provider", () => {
    expect(resolveMcpSpawnRunner("claude", "codex")).toEqual({ runner: "codex", label: "codex" });
    expect(resolveMcpSpawnRunner("cursor", undefined)).toEqual({ runner: "cursor", label: "cursor" });
  });

  it("falls back to claude for an unknown token (lenient)", () => {
    expect(resolveMcpSpawnRunner("gemini", "nope")).toEqual({ runner: "claude", label: "claude" });
    expect(resolveMcpSpawnRunner(undefined, undefined)).toEqual({ runner: "claude", label: "claude" });
  });

  it("resolves a spoken alias ('cloud agent' → claude) instead of erroring", () => {
    expect(resolveMcpSpawnRunner("claude", "cloud agent")).toEqual({ runner: "claude", label: "claude" });
  });
});
