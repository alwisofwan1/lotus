import { describe, it, expect } from "vitest";
import { shellQuote, terminalRunCommand } from "../task-terminal-command";

describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes safely", () => {
    expect(shellQuote("it's a test")).toBe("'it'\\''s a test'");
  });

  it("keeps newlines and shell metacharacters literal inside the quotes", () => {
    expect(shellQuote("a\n# $x `y`")).toBe("'a\n# $x `y`'");
  });
});

describe("terminalRunCommand", () => {
  it("builds a skip-permissions claude command ending in a carriage return", () => {
    const cmd = terminalRunCommand("do the thing", { skipPermissions: true });
    expect(cmd).toBe("claude --dangerously-skip-permissions 'do the thing'\r");
  });

  it("omits the skip-permissions flag in interactive mode", () => {
    expect(terminalRunCommand("hi", { skipPermissions: false })).toBe("claude 'hi'\r");
  });

  it("defaults to interactive (no flag) when no options are given", () => {
    expect(terminalRunCommand("hi")).toBe("claude 'hi'\r");
  });

  it("escapes a prompt that contains single quotes", () => {
    expect(terminalRunCommand("can't stop", { skipPermissions: true })).toBe(
      "claude --dangerously-skip-permissions 'can'\\''t stop'\r",
    );
  });
});
