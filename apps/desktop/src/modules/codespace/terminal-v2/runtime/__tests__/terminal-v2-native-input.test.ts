import { describe, expect, it, vi } from "vitest";
import { createTerminalV2NativeInputHandler } from "../terminal-v2-native-input";

describe("createTerminalV2NativeInputHandler", () => {
  it("routes only user input and never writes a processor-provided cwd probe", () => {
    const sessionWriter = { write: vi.fn() };
    const suggestionAdapter = { remainderChanged: vi.fn(), layoutChanged: vi.fn() };
    const onInlineCommandSubmit = vi.fn();
    const noteUserInput = vi.fn();
    const processInput = vi.fn(() => ({
      nextInput: "cd src",
      suggestionRemainder: "",
      submittedPrompt: "cd src",
      writeRequest: {
        data: "\r",
        metadata: { origin: "human" as const, intent: "unknown" as const, submitted: false },
      },
      cwdProbeCommand: "pwd\r",
    }));

    const handler = createTerminalV2NativeInputHandler({
      agentCommand: undefined,
      cwd: "/repo",
      history: [],
      noteUserInput,
      onInlineCommandSubmit,
      paneId: "pane-1",
      processInput,
      sessionWriter,
      suggestionAdapter,
    });

    handler.handleInput("\r");

    expect(processInput).toHaveBeenCalledWith(expect.objectContaining({ currentInput: "", data: "\r" }));
    expect(suggestionAdapter.remainderChanged).toHaveBeenCalledWith("");
    expect(onInlineCommandSubmit).toHaveBeenCalledWith("cd src");
    expect(noteUserInput).toHaveBeenCalledWith("pane-1", {
      agentTurnCandidate: false,
      data: "\r",
      submitted: false,
    });
    expect(sessionWriter.write).toHaveBeenCalledWith("pane-1", "\r", {
      origin: "human",
      intent: "unknown",
      submitted: false,
    });
    expect(sessionWriter.write).toHaveBeenCalledTimes(1);
    expect(suggestionAdapter.layoutChanged).toHaveBeenCalled();
  });

});
