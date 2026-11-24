import { describe, expect, it } from "vitest";
import { filterLiveAgentTerminalInput, shouldDropLiveAgentTerminalInput } from "../live-agent-terminal-input";

describe("live agent terminal input filtering", () => {
  it("drops SGR passive hover mouse-move reports", () => {
    expect(shouldDropLiveAgentTerminalInput("\x1b[<35;12;8M")).toBe(true);
    expect(filterLiveAgentTerminalInput("\x1b[<35;12;8M")).toBeNull();
  });

  it("drops passive hover reports even with modifier bits", () => {
    expect(shouldDropLiveAgentTerminalInput("\x1b[<63;12;8M")).toBe(true);
  });

  it("keeps SGR click, drag, wheel, and release reports", () => {
    expect(filterLiveAgentTerminalInput("\x1b[<0;12;8M")).toBe("\x1b[<0;12;8M");
    expect(filterLiveAgentTerminalInput("\x1b[<32;12;8M")).toBe("\x1b[<32;12;8M");
    expect(filterLiveAgentTerminalInput("\x1b[<64;12;8M")).toBe("\x1b[<64;12;8M");
    expect(filterLiveAgentTerminalInput("\x1b[<0;12;8m")).toBe("\x1b[<0;12;8m");
  });

  it("drops legacy passive hover reports", () => {
    const report = `\x1b[MC${String.fromCharCode(44)}${String.fromCharCode(40)}`;
    expect(shouldDropLiveAgentTerminalInput(report)).toBe(true);
  });

  it("keeps normal text and pasted commands", () => {
    expect(filterLiveAgentTerminalInput("npm test\r")).toBe("npm test\r");
    expect(filterLiveAgentTerminalInput("hello world")).toBe("hello world");
  });
});
