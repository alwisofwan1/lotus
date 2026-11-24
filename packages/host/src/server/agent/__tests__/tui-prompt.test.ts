import { describe, expect, it } from "vitest";
import { TUI_READY, typeInitialPrompt } from "../tui-prompt.js";

const ESC = "\u001b";
const ALT_SCREEN = `${ESC}[?1049h`;
const BRACKETED_PASTE = `${ESC}[?2004h`;

function pane(script: string[]) {
  const writes: string[] = [];
  let reads = 0;
  return {
    writes,
    readCount: () => reads,
    port: {
      tail: (_bytes: number) => script[Math.min(reads++, script.length - 1)] ?? "",
      write: (data: string) => { writes.push(data); },
    },
  };
}

const noSleep = { sleep: async (): Promise<void> => undefined };

describe("typeInitialPrompt", () => {
  it("waits for the TUI to take the terminal, then types and submits separately", async () => {
    const p = pane(["$ claude --permission-mode manual", `${ALT_SCREEN}${BRACKETED_PASTE}`]);
    expect(await typeInitialPrompt(p.port, "hello", { ...noSleep, enterAttempts: 1 })).toBe("sent");
    // Text and Enter as two writes: one write carrying both is what left the prompt sitting
    // unsent in the input field.
    expect(p.writes).toEqual(["hello", "\r"]);
  });

  /**
   * A `ccs <account>` cell had its prompt typed and unsent on 2026-09-08: the first Enter
   * landed while the TUI was still reconfiguring after the wrapper handed over. An extra Enter
   * on an empty box is a no-op — three Enters, one turn, verified against a real cell — so the
   * press is repeated rather than timed more cleverly.
   */
  it("presses Enter more than once, for a runner that is still settling", async () => {
    const waits: number[] = [];
    const p = pane([BRACKETED_PASTE]);
    await typeInitialPrompt(p.port, "hello", {
      sleep: async (ms) => { waits.push(ms); },
      enterMs: 100,
    });
    expect(p.writes).toEqual(["hello", "\r", "\r", "\r"]);
    // Spaced further apart each time, so a TUI busy on the first press is free by the next.
    expect(waits.slice(-3)).toEqual([100, 400, 700]);
  });

  it("recognises bracketed paste alone, for a TUI that does not switch screens", async () => {
    const p = pane([BRACKETED_PASTE]);
    expect(await typeInitialPrompt(p.port, "hi", { ...noSleep, enterAttempts: 1 })).toBe("sent");
    expect(p.writes).toEqual(["hi", "\r"]);
  });

  it("types nothing while the shell has not handed over", async () => {
    const p = pane(["", "", ""]);
    const outcome = await typeInitialPrompt(p.port, "hello", { ...noSleep, readyTimeoutMs: 300, pollMs: 100 });
    expect(outcome).toBe("not-ready");
    // A prompt written into a shell that never handed over would run as a command.
    expect(p.writes).toEqual([]);
  });

  it("gives up after the timeout rather than polling for ever", async () => {
    const p = pane([""]);
    await typeInitialPrompt(p.port, "hello", { ...noSleep, readyTimeoutMs: 500, pollMs: 100 });
    expect(p.readCount()).toBeLessThanOrEqual(6);
  });

  it("an empty prompt is nothing to send", async () => {
    const p = pane([BRACKETED_PASTE]);
    expect(await typeInitialPrompt(p.port, "   ", noSleep)).toBe("empty");
    expect(p.writes).toEqual([]);
  });

  it("a pane that cannot be read is not ready", async () => {
    const writes: string[] = [];
    const outcome = await typeInitialPrompt(
      { tail: () => { throw new Error("no session"); }, write: (d) => { writes.push(d); } },
      "hello",
      { ...noSleep, readyTimeoutMs: 200, pollMs: 100 },
    );
    expect(outcome).toBe("not-ready");
    expect(writes).toEqual([]);
  });

  it("the readiness pattern is the handover, not what the screen says", () => {
    expect(TUI_READY.test(BRACKETED_PASTE)).toBe(true);
    expect(TUI_READY.test(ALT_SCREEN)).toBe(true);
    expect(TUI_READY.test('Try "fix lint errors"')).toBe(false);
  });
});
