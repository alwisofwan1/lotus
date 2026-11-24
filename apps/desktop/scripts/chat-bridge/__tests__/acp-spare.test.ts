import path from "node:path";

import { describe, expect, it } from "vitest";

import { AcpSession, listAcpCommands, listAcpModels, warmAcp } from "../acp-session";
import { acpAgent } from "../../../src/modules/chat/providers/acp/agents";
import { killAllAgentProcesses } from "../codex-session";

const agent = { ...acpAgent("antigravity")!, args: [path.join(__dirname, "fixtures/fake-acp-agent.mjs")] };
const env = { PATH: process.env.PATH ?? "" };

function session() {
  return new AcpSession({
    threadId: "t",
    cwd: "/tmp",
    agent,
    path: process.execPath,
    env,
    permissionMode: "default",
    describe: () => ({ toolName: "x", toolUseId: null, input: {}, blockedPath: null }),
    requestPermission: async () => ({ behavior: "deny", message: "" }),
    onMessage: () => {},
    onEnded: () => {},
  });
}

const pidOf = (s: AcpSession) => s.providerSessionId?.split("-")[0];

describe("the spare ACP process", () => {
  it("lists models from the spare, then a chat starts on that same process; the next chat boots its own", async () => {
    expect(await listAcpModels(agent, process.execPath, env)).toEqual([expect.objectContaining({ value: "m1", isDefault: true })]);
    const sparePid = (await warmAcp(agent, process.execPath, env)).first.sessionId?.split("-")[0];
    const first = session();
    await first.start();
    expect(pidOf(first)).toBe(sparePid);
    expect(first.providerSessionId).toMatch(/-2$/); // its second session/new: the slow first one was the spare's
    const second = session();
    await second.start();
    expect(pidOf(second)).not.toBe(sparePid);
    first.stop();
    second.stop();
  });

  it("lists `/` commands for the asked cwd, on the spare", async () => {
    const sparePid = (await warmAcp(agent, process.execPath, env)).first.sessionId?.split("-")[0];
    expect(await listAcpCommands(agent, process.execPath, env, "/work")).toEqual([
      { name: "compact", description: "Compact" },
      { name: "skill-in-/work", description: "A skill" },
    ]);
    const chat = session();
    await chat.start();
    expect(pidOf(chat)).toBe(sparePid);
    chat.stop();
  });
});

describe("bridge shutdown", () => {
  // cursor-agent with MCP servers ignores stdin EOF; seen live, a bridge exit left it orphaned.
  it("kills the warm spare too, not only the chats", async () => {
    const pid = Number((await warmAcp(agent, process.execPath, env)).first.sessionId?.split("-")[0]);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    killAllAgentProcesses();
    await expect.poll(alive, { timeout: 3000 }).toBe(false);
  });
});

describe("Lotus's note for an agent with no system-prompt hook", () => {
  async function firstBlocks(over: Partial<typeof agent>, resumeSessionId?: string): Promise<string[]> {
    const seen: string[] = [];
    let turns = 0;
    let ended: () => void = () => {};
    const s = new AcpSession({
      threadId: "t",
      cwd: "/tmp",
      agent: { ...agent, ...over },
      path: process.execPath,
      env,
      permissionMode: "default",
      resumeSessionId,
      describe: () => ({ toolName: "x", toolUseId: null, input: {}, blockedPath: null }),
      requestPermission: async () => ({ behavior: "deny", message: "" }),
      onMessage: (m) => {
        const p = (m as { method: string; params: { update?: { content?: { text?: string } } } });
        if (p.method === "session/update" && p.params.update?.content?.text !== undefined) seen.push(p.params.update.content.text);
        if (p.method === "lotus/turnEnded" && ++turns === 2) ended();
      },
      onEnded: () => {},
    });
    await s.start();
    const done = new Promise<void>((resolve) => (ended = resolve));
    await s.send("one", "u1");
    await s.send("two", "u2");
    await done;
    s.stop();
    return seen;
  }

  it("goes in front of the first message only (Cursor)", async () => {
    const [first, second] = await firstBlocks({ systemPromptMeta: undefined });
    expect(first).toMatch(/^<lotus-instructions>\n[\s\S]*lotus_chat_delegate/);
    expect(second).toBe("two");
  });

  it("is not added where the agent takes it as a system prompt (Antigravity), nor on a resumed chat", async () => {
    expect(await firstBlocks({})).toEqual(["one", "two"]);
    expect(await firstBlocks({ systemPromptMeta: undefined }, "resumed-1")).toEqual(["one", "two"]);
  });
});

