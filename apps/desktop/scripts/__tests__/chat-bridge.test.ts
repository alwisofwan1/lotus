import { describe, expect, it } from "vitest";

import { childEnv } from "../chat-bridge/claude-session";
import { InputQueue } from "../chat-bridge/input-queue";
import { inboundMessageSchema, interactionDecisionSchema, threadStartParams } from "../chat-bridge/protocol";
import { resolveClaudeExecutable } from "../chat-bridge/resolve-claude";

describe("InputQueue", () => {
  it("settles a push only when the consumer takes it", async () => {
    const queue = new InputQueue<string>();
    let consumed = false;
    const pushed = queue.push("a").then(() => {
      consumed = true;
    });
    await Promise.resolve();
    expect(consumed).toBe(false);

    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: "a", done: false });
    await pushed;
    expect(consumed).toBe(true);
  });

  it("hands a push straight to a consumer that is already waiting", async () => {
    const queue = new InputQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const next = iterator.next();
    await queue.push("b");
    expect(await next).toEqual({ value: "b", done: false });
  });

  it("rejects pushes that were never consumed when it closes, and ends the waiting consumer", async () => {
    const queue = new InputQueue<string>();
    const lost = queue.push("never read");
    queue.close("stopped");
    await expect(lost).rejects.toThrow("stopped");
    await expect(queue.push("late")).rejects.toThrow("closed");

    const waiting = new InputQueue<string>();
    const next = waiting[Symbol.asyncIterator]().next();
    waiting.close("stopped");
    expect(await next).toEqual({ value: undefined, done: true });
  });
});

describe("resolveClaudeExecutable", () => {
  const onlyAt = (path: string) => (candidate: string) => candidate === path;

  it("finds claude in ~/.local/bin when PATH is the minimal GUI PATH", () => {
    expect(
      resolveClaudeExecutable({
        env: { PATH: "/usr/bin:/bin" },
        home: "/Users/me",
        isExecutable: onlyAt("/Users/me/.local/bin/claude"),
      }),
    ).toBe("/Users/me/.local/bin/claude");
  });

  it("prefers PATH over the well-known locations", () => {
    expect(
      resolveClaudeExecutable({
        env: { PATH: "/custom/bin" },
        home: "/Users/me",
        isExecutable: (p) => p === "/custom/bin/claude" || p === "/Users/me/.local/bin/claude",
      }),
    ).toBe("/custom/bin/claude");
  });

  it("uses LOTUS_CLAUDE_PATH only, and reports null when it is not executable", () => {
    const env = { LOTUS_CLAUDE_PATH: "/opt/claude", PATH: "/usr/local/bin" };
    expect(resolveClaudeExecutable({ env, home: "/h", isExecutable: onlyAt("/opt/claude") })).toBe("/opt/claude");
    expect(resolveClaudeExecutable({ env, home: "/h", isExecutable: onlyAt("/usr/local/bin/claude") })).toBeNull();
  });

  it("returns null when claude is nowhere", () => {
    expect(resolveClaudeExecutable({ env: { PATH: "/usr/bin" }, home: "/h", isExecutable: () => false })).toBeNull();
  });
});

describe("childEnv", () => {
  it("drops the parent Claude Code session markers and keeps everything else", () => {
    expect(
      childEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", HOME: "/h", ANTHROPIC_API_KEY: "k", EMPTY: undefined }),
    ).toEqual({ HOME: "/h", ANTHROPIC_API_KEY: "k" });
  });
});

describe("protocol", () => {
  it("defaults the permission mode to default, never to bypass", () => {
    expect(threadStartParams.parse({ threadId: "t", cwd: "/w" }).permissionMode).toBe("default");
  });

  it("requires a message for a deny decision", () => {
    expect(interactionDecisionSchema.safeParse({ behavior: "deny" }).success).toBe(false);
    expect(interactionDecisionSchema.safeParse({ behavior: "allow" }).success).toBe(true);
  });

  it("accepts requests and responses and rejects anything that is not JSON-RPC 2.0", () => {
    expect(inboundMessageSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "initialize" }).success).toBe(true);
    expect(inboundMessageSchema.safeParse({ jsonrpc: "2.0", id: "b-1", result: { behavior: "allow" } }).success).toBe(true);
    expect(inboundMessageSchema.safeParse({ id: 1, method: "initialize" }).success).toBe(false);
  });
});
