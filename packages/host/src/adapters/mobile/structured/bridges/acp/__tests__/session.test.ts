import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acpAgent, type AcpAgentDefinition } from "../known-agents.js";
import { AcpSession } from "../session.js";

const FAKE = join(__dirname, "fake-agent.mjs");
function cursorAgent(): AcpAgentDefinition {
  const agent = acpAgent("cursor");
  if (agent === undefined) throw new Error("the cursor agent definition went missing");
  return agent;
}

const open: AcpSession[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** A session pointed at the fake agent rather than the real binary. */
function session(script: string, permissionMode?: string): AcpSession {
  process.env["FAKE_ACP"] = script;
  const s = new AcpSession({
    paneId: "ss-fake",
    cwd: process.cwd(),
    agent: cursorAgent(),
    command: process.execPath,
    args: [FAKE],
    ...(permissionMode === undefined ? {} : { permissionMode }),
  });
  open.push(s);
  return s;
}

describe("AcpSession", () => {
  it("handshakes, authenticates, and reports the agent's session id as the thread", async () => {
    const s = session("ok");
    await s.start();
    expect(s.thread).toBe("sess-fake");
    expect(s.alive).toBe(true);
  });

  it("resolves a prompt when the turn ends, with the streamed text already assembled", async () => {
    const s = session("ok");
    await s.start();
    await s.prompt("say hello");
    const turn = s.conversation.page().turns[0];
    expect(turn?.stopReason).toBe("end_turn");
    expect(turn?.parts.find((p) => p.type === "assistant_text")).toMatchObject({
      text: "hello",
      state: "done",
    });
    expect(s.conversation.title).toBe("Fake Turn");
  });

  it("switches into the read-only mode when that is the stop the caller asked for", async () => {
    const s = session("ok", "read-only");
    await s.start();
    expect(s.conversation.mode).toBe("plan");
  });

  it("leaves the agent in its own mode for any other stop", async () => {
    const s = session("ok", "yolo");
    await s.start();
    expect(s.conversation.mode).toBeUndefined();
  });

  it("holds a permission request open until the phone answers, then unblocks the turn", async () => {
    const s = session("permission");
    await s.start();
    const turn = s.prompt("delete everything");
    await waitFor(() => s.conversation.pendingPermission() !== undefined);
    const pending = s.conversation.pendingPermission();
    expect(pending).toMatchObject({ title: "Run `rm -rf /`", toolCallId: "call-1 fc_1" });
    expect(s.decide("nonsense")).toBe(false);
    expect(s.decide("allow")).toBe(true);
    await turn;
    expect(s.conversation.pendingPermission()).toBeUndefined();
    const call = s.conversation.page().turns[0]?.parts.find((p) => p.type === "tool_call");
    expect(call).toMatchObject({ status: "completed" });
  });

  it("answers `false` to a decision when nothing is waiting", async () => {
    const s = session("ok");
    await s.start();
    expect(s.decide("allow")).toBe(false);
  });

  it("names the sign-in command when the agent refuses to authenticate", async () => {
    const s = session("unauthed");
    await expect(s.start()).rejects.toThrow(/cursor-agent login/);
  });

  it("turns a failed turn into an error part rather than a rejected promise", async () => {
    const s = session("ok");
    await s.start();
    s.close();
    await s.prompt("after the agent is gone");
    const turn = s.conversation.page().turns[0];
    expect(turn?.stopReason).toBe("error");
    expect(turn?.parts.at(-1)).toMatchObject({ type: "error" });
  });

  it("reports a killed process as no longer alive", async () => {
    const s = session("ok");
    await s.start();
    s.close();
    await waitFor(() => !s.alive);
    expect(s.alive).toBe(false);
  });
});

async function waitFor(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the fake agent");
    await new Promise((r) => setTimeout(r, 10));
  }
}
