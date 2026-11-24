import { describe, expect, it } from "vitest";

import { reduceInlineTerminalInput } from "../terminal-inline-suggestions";

describe("inline terminal suggestions", () => {
  it("accepts the top suggestion on Tab for matching prefixes", () => {
    const typed = reduceInlineTerminalInput("", "g", []);
    const typedAgain = reduceInlineTerminalInput(typed.nextInput, "i", []);
    const typedThird = reduceInlineTerminalInput(typedAgain.nextInput, "t", []);
    const typedFourth = reduceInlineTerminalInput(typedThird.nextInput, " ", []);
    const typedFifth = reduceInlineTerminalInput(typedFourth.nextInput, "c", []);
    const typedSixth = reduceInlineTerminalInput(typedFifth.nextInput, "h", []);

    const accepted = reduceInlineTerminalInput(typedSixth.nextInput, "\t", []);

    expect(accepted.writeData).toBe("eckout");
    expect(accepted.nextInput).toBe("git checkout");
    expect(accepted.intercepted).toBe(true);
  });

  it("passes normal printable input through and tracks the inline prompt buffer", () => {
    const result = reduceInlineTerminalInput("git ", "s", []);

    expect(result.writeData).toBe("s");
    expect(result.nextInput).toBe("git s");
    expect(result.intercepted).toBe(false);
    expect(result.suggestion?.command).toBe("git status");
  });

  it("clears the inline prompt buffer when the user submits the command", () => {
    const result = reduceInlineTerminalInput("git status", "\r", []);

    expect(result.writeData).toBe("\r");
    expect(result.nextInput).toBe("");
    expect(result.suggestion).toBeNull();
  });

  it("tracks pasted text and clears it when the paste includes submit", () => {
    const pasted = reduceInlineTerminalInput("", "buat biografi", []);
    const submitted = reduceInlineTerminalInput("", "buat biografi\r", []);

    expect(pasted.nextInput).toBe("buat biografi");
    expect(submitted.nextInput).toBe("");
  });
});
