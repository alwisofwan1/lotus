import { describe, it, expect } from "vitest";
import { parseOsc133 } from "../terminal-osc133";

describe("parseOsc133", () => {
  it("extracts command begin/end and strips the markers from visible data", () => {
    const res = parseOsc133("before\x1b]133;C\x07npm test\x1b]133;D;0\x07after");
    expect(res.visibleData).toBe("beforenpm testafter");
    expect(res.events).toEqual([
      { kind: "command-begin" },
      { kind: "command-end", exitCode: 0 },
    ]);
  });

  it("captures prompt-start and command-read markers", () => {
    const res = parseOsc133("\x1b]133;A\x07$ \x1b]133;B\x07");
    expect(res.events.map((e) => e.kind)).toEqual(["prompt-start", "command-read"]);
    expect(res.visibleData).toBe("$ ");
  });

  it("parses a non-zero exit code on command-end", () => {
    const res = parseOsc133("\x1b]133;D;127\x07");
    expect(res.events).toEqual([{ kind: "command-end", exitCode: 127 }]);
  });

  it("accepts the ST terminator (ESC backslash) as well as BEL", () => {
    const res = parseOsc133("\x1b]133;C\x1b\\x");
    expect(res.events).toEqual([{ kind: "command-begin" }]);
    expect(res.visibleData).toBe("x");
  });

  it("treats command-end without a status as undefined exit code", () => {
    const res = parseOsc133("\x1b]133;D\x07");
    expect(res.events).toEqual([{ kind: "command-end", exitCode: undefined }]);
  });

  it("returns input unchanged when no OSC 133 markers are present", () => {
    const res = parseOsc133("plain output\x1b]7;file:///tmp\x07");
    expect(res.visibleData).toBe("plain output\x1b]7;file:///tmp\x07");
    expect(res.events).toEqual([]);
  });
});
