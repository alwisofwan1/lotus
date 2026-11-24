import { describe, expect, it } from "vitest";
import { parsePtySessionEnd } from "../pty-session-end";

describe("parsePtySessionEnd", () => {
  it("recognizes an exit marker after the decoder flushes a truncated UTF-8 character", () => {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    expect(decoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true })).toBe("");
    const data = decoder.decode(new TextEncoder().encode("[Session ended:137]\r\n"), { stream: true });
    expect(data).toBe("\uFFFD[Session ended:137]\r\n");
    expect(parsePtySessionEnd(data)).toBe(137);
  });

  it("preserves surrounding output even when a marker has a replacement character prefix", () => {
    expect(parsePtySessionEnd("example \uFFFD[Session ended:137]\r\n")).toBeNull();
    expect(parsePtySessionEnd("\uFFFD[Session ended:137]\r\nmore output")).toBeNull();
  });
});
