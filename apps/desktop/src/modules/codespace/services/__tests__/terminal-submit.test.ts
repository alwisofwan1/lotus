import { describe, expect, it } from "vitest";

import { encodeTerminalCommandSubmission, encodeTerminalTextSubmission } from "../terminal-submit";

describe("encodeTerminalCommandSubmission", () => {
  it("submits single-line commands with a trailing carriage return", () => {
    expect(encodeTerminalCommandSubmission("git status")).toBe("git status\r");
  });

  it("submits multiline commands via bracketed paste followed by Enter", () => {
    expect(encodeTerminalCommandSubmission("echo one\nand two")).toBe(
      "\u001b[200~echo one\nand two\u001b[201~\r",
    );
  });

  it("normalizes a trailing line ending into a single Enter submission", () => {
    expect(encodeTerminalTextSubmission("Hello world\n")).toBe("Hello world\r");
    expect(encodeTerminalTextSubmission("Hello world\r")).toBe("Hello world\r");
  });

  it("submits multiline text via bracketed paste followed by Enter", () => {
    expect(encodeTerminalTextSubmission("review this\nwith context")).toBe(
      "\u001b[200~review this\nwith context\u001b[201~\r",
    );
  });
});
