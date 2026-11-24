import { describe, expect, it, vi } from "vitest";
import {
  normalizeTerminalV2NativeInitialCommand,
  sendTerminalV2NativeInitialCommand,
} from "../terminal-v2-native-initial-command";

describe("Terminal V2 native initial command helper", () => {
  it("normalizes to one trailing carriage return", () => {
    expect(normalizeTerminalV2NativeInitialCommand("pnpm dev")).toBe("pnpm dev\r");
    expect(normalizeTerminalV2NativeInitialCommand("pnpm dev\r")).toBe("pnpm dev\r");
    expect(normalizeTerminalV2NativeInitialCommand(null)).toBeNull();
  });

  it("sends created-session initial command once with system metadata", () => {
    const write = vi.fn();
    const sentKeys = new Set<string>();

    expect(sendTerminalV2NativeInitialCommand({
      created: true,
      initialCommand: "pnpm dev",
      paneId: "pane-1",
      sentKeys,
      terminalCommand: undefined,
      write,
    })).toBe(true);
    expect(sendTerminalV2NativeInitialCommand({
      created: true,
      initialCommand: "pnpm dev",
      paneId: "pane-1",
      sentKeys,
      terminalCommand: undefined,
      write,
    })).toBe(false);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("pane-1", "pnpm dev\r", {
      origin: "system",
      intent: "initial-command",
      submitted: false,
    });
  });

  it("skips reattach and direct terminal commands", () => {
    const write = vi.fn();
    const sentKeys = new Set<string>();

    expect(sendTerminalV2NativeInitialCommand({
      created: false,
      initialCommand: "pnpm dev",
      paneId: "pane-1",
      sentKeys,
      terminalCommand: undefined,
      write,
    })).toBe(false);
    expect(sendTerminalV2NativeInitialCommand({
      created: true,
      initialCommand: "pnpm dev",
      paneId: "pane-1",
      sentKeys,
      terminalCommand: ["node"],
      write,
    })).toBe(false);

    expect(write).not.toHaveBeenCalled();
  });
});
