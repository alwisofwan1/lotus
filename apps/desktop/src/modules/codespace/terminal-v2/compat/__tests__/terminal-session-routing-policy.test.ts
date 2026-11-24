import { describe, expect, it } from "vitest";
import { resolveTerminalSessionCreateRoute } from "../terminal-session-routing-policy";

describe("terminal session routing policy", () => {
  it("routes local CodeSpace session creation to V2", () => {
    expect(resolveTerminalSessionCreateRoute({
      location: { kind: "local", cwd: "/repo" },
    })).toBe("v2");
  });

  it("does not preserve SSH as a legacy session-creation fallback", () => {
    expect(resolveTerminalSessionCreateRoute({
      location: { kind: "ssh", host: "example.com" },
    })).toBe("v2");
  });

  it("keeps Canvas terminal sessions on legacy until a Canvas adapter exists", () => {
    expect(resolveTerminalSessionCreateRoute({
      canvasTerminalId: "canvas-node-1",
    })).toBe("legacy");
  });
});
