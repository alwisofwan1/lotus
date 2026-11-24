import { describe, expect, it } from "vitest";
import {
  processTerminalV2InputEvent,
} from "../terminal-v2-input-event-adapter";

const baseInput = {
  currentInput: "",
  data: "l",
  history: [] as string[],
  cwd: "/repo",
};

describe("processTerminalV2InputEvent", () => {
  it("updates inline input and emits a human write request for ordinary typing", () => {
    const result = processTerminalV2InputEvent(baseInput);

    expect(result).toMatchObject({
      nextInput: "l",
      suggestionRemainder: "s",
      submittedPrompt: "",
      cwdProbeCommand: null,
      writeRequest: {
        data: "l",
        metadata: {
          origin: "human",
          intent: "unknown",
          submitted: false,
        },
      },
    });
  });

  it("marks submitted agent prompts as conversation prompts", () => {
    const result = processTerminalV2InputEvent({
      ...baseInput,
      currentInput: "explain this failure",
      data: "\r",
      agentCommand: "claude",
    });

    expect(result.nextInput).toBe("");
    expect(result.writeRequest).toEqual({
      data: "\r",
      metadata: {
        origin: "human",
        intent: "conversation-prompt",
        submitted: true,
        promptText: "explain this failure",
      },
    });
  });

  it("normalizes a single CRLF input event to one Enter", () => {
    const result = processTerminalV2InputEvent({
      ...baseInput,
      currentInput: "",
      data: "\r\n",
    });

    expect(result.nextInput).toBe("");
    expect(result.writeRequest?.data).toBe("\r");
    expect(result.writeRequest?.metadata).toMatchObject({
      origin: "human",
      submitted: false,
    });
  });

  it("does not inject a visible cwd probe after submitted cd commands", () => {
    const result = processTerminalV2InputEvent({
      ...baseInput,
      currentInput: "cd packages/app",
      data: "\r",
    });

    expect(result.cwdProbeCommand).toBeNull();
    expect(result.writeRequest?.metadata).toMatchObject({
      submitted: true,
      promptText: "cd packages/app",
    });
  });

  it("computes suggestion remainder from the next inline input", () => {
    const result = processTerminalV2InputEvent({
      ...baseInput,
      currentInput: "git statu",
      data: "s",
      history: ["git status"],
    });

    expect(result.nextInput).toBe("git status");
    expect(result.suggestionRemainder).toBe("");
  });

  it("does not emit a write request for empty renderer input", () => {
    const result = processTerminalV2InputEvent({
      ...baseInput,
      data: "",
    });

    expect(result.writeRequest).toBeNull();
    expect(result.nextInput).toBe("");
  });
});
