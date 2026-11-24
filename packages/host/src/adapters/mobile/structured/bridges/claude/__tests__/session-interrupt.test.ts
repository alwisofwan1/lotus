import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeStreamSession } from "../session.js";

const FAKE = join(__dirname, "fake-claude.mjs");

const open: ClaudeStreamSession[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function session(script: string): ClaudeStreamSession {
  process.env["FAKE_CLAUDE"] = script;
  const s = new ClaudeStreamSession({ paneId: "ss-claude", cwd: process.cwd(), command: process.execPath, args: [FAKE], approvals: false });
  open.push(s);
  return s;
}

describe("stopping a turn", () => {
  it("ends the turn as a cancel and keeps the cell for the next message", async () => {
    const s = session("interruptible");
    const first = s.prompt("long essay");
    await new Promise((r) => setTimeout(r, 50));

    await s.interrupt();
    await first;
    await s.prompt("again");

    const turns = s.conversation.page().turns;
    expect(s.alive).toBe(true);
    expect(turns.map((t) => t.stopReason)).toEqual(["cancelled", "end_turn"]);
  });

  it("falls back to SIGINT when the runner does not answer the control", async () => {
    const s = session("deaf");
    const first = s.prompt("go");
    await new Promise((r) => setTimeout(r, 50));

    await s.interrupt(100);
    await first;

    expect(s.alive).toBe(false);
  });

  it("does nothing on a cell that is already gone", async () => {
    const s = session("ok");
    s.close();
    await new Promise((r) => setTimeout(r, 50));
    await expect(s.interrupt(100)).resolves.toBeUndefined();
  });
});
