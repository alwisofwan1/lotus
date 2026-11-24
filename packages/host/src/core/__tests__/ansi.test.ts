import { describe, it, expect } from "vitest";
import { stripAnsi } from "../ansi.js";

describe("stripAnsi", () => {
  it("passes through plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1B[32mgreen\x1B[0m")).toBe("green");
  });

  it("removes bold + reset sequences", () => {
    expect(stripAnsi("\x1B[1mbold\x1B[22m")).toBe("bold");
  });

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("\x1B[2Jtext\x1B[H")).toBe("text");
  });

  it("removes hyperlink OSC sequences", () => {
    expect(stripAnsi("\x1B]8;;https://example.com\x1B\\link\x1B]8;;\x1B\\")).toBe("link");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("handles string with no escape sequences", () => {
    const plain = "line1\nline2\nline3";
    expect(stripAnsi(plain)).toBe(plain);
  });

  it("removes interleaved sequences", () => {
    expect(stripAnsi("a\x1B[31mb\x1B[0mc")).toBe("abc");
  });
});
