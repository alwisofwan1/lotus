import { describe, expect, it } from "vitest";
import { settingsFor } from "../claude-session";

const claudeJson = { mcpServers: { lotus: { command: "bun", args: ["/app/lotus-mcp-server.mjs"] }, other: { command: "x" } } };
const env = { LOTUS_PROFILE_KEY: "lotus", LOTUS_CHAT_THREAD_ID: "t1" };

describe("settingsFor", () => {
  it("loads every settings layer for an ordinary chat", () => {
    expect(settingsFor(false, env, () => claudeJson)).toEqual({ settingSources: ["user", "project", "local"] });
  });

  it("loads none for a strict chat, and passes only this app's Lotus MCP", () => {
    expect(settingsFor(true, env, () => claudeJson)).toEqual({
      settingSources: [],
      mcpServers: { lotus: { type: "stdio", command: "bun", args: ["/app/lotus-mcp-server.mjs"], env: { LOTUS_PROFILE_KEY: "lotus", LOTUS_CHAT_THREAD_ID: "t1" } } },
    });
  });

  it("stays strict when ~/.claude.json cannot be read", () => {
    expect(
      settingsFor(true, env, () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({ settingSources: [], mcpServers: {} });
  });
});
