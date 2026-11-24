import { describe, expect, it, vi } from "vitest";
import { createHandoverGate, submitAsKeystrokes } from "../tui-handover";

describe("handover gate", () => {
  it("is closed until the terminal announces its line editor", () => {
    const gate = createHandoverGate();
    expect(gate.ready).toBe(false);
    gate.observe("Last login: Tue Sep  9 22:00:00 on ttys004\r\n");
    expect(gate.ready).toBe(false);
  });

  it("opens on bracketed paste, the marker a zsh line editor emits before its prompt", () => {
    const gate = createHandoverGate();
    // Shape taken from src-tauri/src/permission_prompt_fixtures/live-stream-80x24.bin, where this
    // sequence precedes the typed command line.
    gate.observe("\x1b[1;32m❯\x1b[0m \x1b[K\x1b[?1h=\x1b[?2004h");
    expect(gate.ready).toBe(true);
  });

  it("opens on the alt screen a full-screen TUI switches to", () => {
    const gate = createHandoverGate();
    gate.observe("\x1b[?1049h\x1b[2J");
    expect(gate.ready).toBe(true);
  });

  it("survives a marker split across two output chunks", () => {
    const gate = createHandoverGate();
    gate.observe("banner \x1b[?20");
    gate.observe("04h❯ ");
    expect(gate.ready).toBe(true);
  });

  it("waits for a marker that arrives late, then reports open", async () => {
    const gate = createHandoverGate();
    const sleep = vi.fn(async () => { gate.observe("\x1b[?2004h"); });
    await expect(gate.wait({ timeoutMs: 1_000, pollMs: 100, sleep })).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up when no marker ever arrives, so the caller never types blind", async () => {
    const gate = createHandoverGate();
    const sleep = vi.fn(async () => {});
    await expect(gate.wait({ timeoutMs: 300, pollMs: 100, sleep })).resolves.toBe(false);
  });
});

describe("submitAsKeystrokes", () => {
  it("sends the text and each Enter as its own write, so no burst reads as a paste", async () => {
    const writes: string[] = [];
    await submitAsKeystrokes((data) => { writes.push(data); }, "hello world", {
      sleep: async () => {},
      enterAttempts: 3,
    });

    expect(writes[0]).toBe("hello world");
    expect(writes.slice(1)).toEqual(["\r", "\r", "\r"]);
    expect(writes[0]).not.toContain("\r");
    expect(writes[0]).not.toContain("\n");
  });

  it("spaces the Enter presses further apart each time, for a runner still settling", async () => {
    const waits: number[] = [];
    await submitAsKeystrokes(() => {}, "hi", {
      sleep: async (ms) => { waits.push(ms); },
      settleMs: 250,
      enterMs: 150,
      enterAttempts: 3,
    });

    expect(waits).toEqual([250, 150, 600, 1050]);
  });
});

describe("handover gate behind a shell", () => {
  // The order in src-tauri/src/permission_prompt_fixtures/live-stream-80x24.bin: the shell arms
  // bracketed paste at its prompt, drops it when `claude …` is accepted, then the agent takes over.
  const SHELL_PROMPT = "\x1b[1;32m❯\x1b[0m \x1b[K\x1b[?1h=\x1b[?2004h";
  const COMMAND_ACCEPTED = "claude --permission-mode manual\x1b[?1l>\x1b[?2004l\r\r\n";

  it("does not take the shell's own prompt for the agent", () => {
    const gate = createHandoverGate({ behindShell: true });
    gate.observe(SHELL_PROMPT);
    expect(gate.ready).toBe(false);
    gate.observe(COMMAND_ACCEPTED);
    expect(gate.ready).toBe(false);
  });

  it("opens on the agent's marker after the shell hands over", () => {
    const gate = createHandoverGate({ behindShell: true });
    gate.observe(SHELL_PROMPT + COMMAND_ACCEPTED + "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?1049h");
    expect(gate.ready).toBe(true);
  });

  it("follows the order across chunks, including a split hand-over marker", () => {
    const gate = createHandoverGate({ behindShell: true });
    gate.observe(SHELL_PROMPT + "claude\x1b[?20");
    gate.observe("04l\r\n");
    expect(gate.ready).toBe(false);
    gate.observe("booting\x1b[?2004h");
    expect(gate.ready).toBe(true);
  });

  it("does not count a marker twice when the next chunk is small", () => {
    // The shell's `h` stays inside the carried tail; re-reading it must not open the gate once
    // the `l` arrives in the following chunk.
    const gate = createHandoverGate({ behindShell: true });
    gate.observe("\x1b[?2004h");
    gate.observe("\x1b[?2004l");
    expect(gate.ready).toBe(false);
  });

  it("a gate with no shell still opens on the first marker", () => {
    const gate = createHandoverGate();
    gate.observe(SHELL_PROMPT);
    expect(gate.ready).toBe(true);
  });
});
