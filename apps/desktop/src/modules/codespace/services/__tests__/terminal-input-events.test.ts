import { describe, expect, it } from "vitest";
import { extractSubmittedTerminalPrompt } from "@/modules/codespace/services/terminal-input-events";

describe("terminal input events", () => {
  it("extracts the submitted prompt from a standalone enter key", () => {
    expect(extractSubmittedTerminalPrompt("\r", "review this")).toBe("review this");
  });

  it("extracts the submitted prompt from pasted input chunks", () => {
    expect(extractSubmittedTerminalPrompt("review this\r", "")).toBe("review this");
    expect(extractSubmittedTerminalPrompt("review this\n", "")).toBe("review this");
    expect(extractSubmittedTerminalPrompt("review this\r\n", "")).toBe("review this");
  });

  it("combines tracked typing with a submitted input chunk", () => {
    expect(extractSubmittedTerminalPrompt(" this\r", "review")).toBe("review this");
  });

  it("returns empty text for partial typing", () => {
    expect(extractSubmittedTerminalPrompt("review this", "")).toBe("");
  });
});
