import { describe, expect, it } from "vitest";
import { extractTerminalCwdUpdates } from "@/modules/codespace/services/terminal-cwd-probe";

describe("terminal-cwd-probe", () => {

  it("extracts absolute cwd OSC updates and removes them from visible output", () => {
    const result = extractTerminalCwdUpdates(
      "before\x1b]777;lotus-cwd=/home/alwi/workspace/acme-main\x07after",
    );

    expect(result.visibleData).toBe("beforeafter");
    expect(result.cwdUpdates).toEqual(["/home/alwi/workspace/acme-main"]);
  });

  it("ignores non-absolute cwd updates", () => {
    const result = extractTerminalCwdUpdates("\x1b]777;lotus-cwd=~\x07");

    expect(result.visibleData).toBe("");
    expect(result.cwdUpdates).toEqual([]);
  });
});
