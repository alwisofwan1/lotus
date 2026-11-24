import { describe, it, expect } from "vitest";
import { selectPtyBackendKind } from "../backend-choice.js";

describe("selectPtyBackendKind", () => {
  it("runs a standalone host on lotus-sessiond and a client-mode embed on node-pty", () => {
    // Durability is a standalone concern: this is the host that gets left running on a VPS.
    expect(selectPtyBackendKind({ mode: "standalone", env: {} }).kind).toBe("sessiond");
    expect(selectPtyBackendKind({ mode: "client", env: {} }).kind).toBe("node-pty");
  });

  it("lets LOTUS_PTY override the mode's default", () => {
    // The escape hatch matters on the day the daemon is the thing that broke.
    expect(selectPtyBackendKind({ mode: "standalone", env: { LOTUS_PTY: "node-pty" } }).kind).toBe("node-pty");
    expect(selectPtyBackendKind({ mode: "standalone", env: { LOTUS_PTY: " node-pty " } }).kind).toBe("node-pty");
    // tmux is gone (ADR-0067); a stale env file falls back to the mode's default.
    expect(selectPtyBackendKind({ mode: "standalone", env: { LOTUS_PTY: "tmux" } }).kind).toBe("sessiond");
    expect(selectPtyBackendKind({ mode: "client", env: { LOTUS_PTY: "sessiond" } }).kind).toBe("sessiond");
    expect(selectPtyBackendKind({ mode: "standalone", env: { LOTUS_PTY: "bogus" } }).kind).toBe("sessiond");
  });
});
