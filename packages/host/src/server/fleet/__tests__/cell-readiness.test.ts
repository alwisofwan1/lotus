import { describe, it, expect } from "vitest";
import {
  classifyCellState,
  defaultWaitTimeoutMs,
  isIdle,
  legacyState,
  stripAnsi,
} from "../cell-readiness.js";

describe("stripAnsi", () => {
  it("removes CSI colour sequences", () => {
    expect(stripAnsi("[31mred[0m")).toBe("red");
  });
  it("removes OSC sequences terminated by BEL", () => {
    expect(stripAnsi("]0;titletext")).toBe("text");
  });
});

describe("classifyCellState", () => {
  it("classifies a Claude TUI footer as ready_tui", () => {
    const c = classifyCellState("doing work\n? for shortcuts");
    expect(c.readiness).toBe("ready_tui");
    expect(c.matched).toBe("? for shortcuts");
  });

  it("classifies a shell prompt as ready_shell", () => {
    expect(classifyCellState("done\n$ ").readiness).toBe("ready_shell");
  });

  it("honours a custom signature as a ready hint (takes precedence)", () => {
    const c = classifyCellState("...DONE-MARKER...", ["done-marker"]);
    expect(c.readiness).toBe("ready_shell");
    expect(c.matched).toBe("done-marker");
  });

  it("detects an auth-required prompt", () => {
    expect(classifyCellState("the mcp server needs to authenticate").readiness).toBe("auth_required");
  });

  it("detects a dialog and suggests the auto-dismiss input", () => {
    const c = classifyCellState("Installing...\npress enter to continue");
    expect(c.readiness).toBe("dialog");
    expect(c.suggestedInput).toBe("\r");
  });

  it("classifies a heavy-ANSI low-text frame as unknown_tui", () => {
    const frame = "[2J[H[34m[1m▕▏[0m";
    expect(classifyCellState(frame).readiness).toBe("unknown_tui");
  });

  it("classifies streaming prose with no prompt as busy", () => {
    expect(classifyCellState("still thinking about the problem and writing code").readiness).toBe("busy");
  });

  it("does not match auth/dialog prose far outside the last 256 chars", () => {
    const c = classifyCellState(`press enter to continue${"x".repeat(400)}\nmore output`);
    expect(c.readiness).toBe("busy");
  });
});

describe("isIdle / legacyState", () => {
  it("treats settled states as idle and maps to legacy buckets", () => {
    expect(isIdle("ready_tui")).toBe(true);
    expect(isIdle("dialog")).toBe(true);
    expect(isIdle("busy")).toBe(false);
    expect(legacyState("ready_shell")).toBe("ready");
    expect(legacyState("unknown_tui")).toBe("ready");
    expect(legacyState("auth_required")).toBe("dialog");
    expect(legacyState("busy")).toBe("busy");
  });
});

describe("defaultWaitTimeoutMs", () => {
  it("gives agent CLIs a longer first-prompt window than a bare shell", () => {
    expect(defaultWaitTimeoutMs("codex")).toBeGreaterThan(defaultWaitTimeoutMs(undefined));
    expect(defaultWaitTimeoutMs("claude")).toBeGreaterThan(defaultWaitTimeoutMs(undefined));
  });
});
