import { describe, expect, it } from "vitest";

import { lotusMcpServers } from "../acp-session";

const claudeJson = {
  mcpServers: {
    lotus: { command: "node", args: ["/h/.lotus/lotus-mcp-server.mjs"] },
    "lotus-dev": { command: "node", args: ["/h/.lotus-dev/lotus-mcp-server.mjs", "--discovery", "/h/.lotus-dev/lotus-mcp-ipc.json"] },
  },
};

describe("lotusMcpServers", () => {
  it("gives the agent this app's own sidecar, with the thread id and profile key in its env", () => {
    expect(lotusMcpServers(claudeJson, { LOTUS_PROFILE_KEY: "lotus-dev", LOTUS_CHAT_THREAD_ID: "t1" })).toEqual([
      {
        name: "lotus-dev",
        command: "node",
        args: ["/h/.lotus-dev/lotus-mcp-server.mjs", "--discovery", "/h/.lotus-dev/lotus-mcp-ipc.json"],
        env: [
          { name: "LOTUS_PROFILE_KEY", value: "lotus-dev" },
          { name: "LOTUS_CHAT_THREAD_ID", value: "t1" },
        ],
      },
    ]);
  });

  it("gives none outside a Lotus app, or when the app registered no sidecar", () => {
    expect(lotusMcpServers(claudeJson, {})).toEqual([]);
    expect(lotusMcpServers({ mcpServers: {} }, { LOTUS_PROFILE_KEY: "lotus" })).toEqual([]);
    expect(lotusMcpServers(null, { LOTUS_PROFILE_KEY: "lotus" })).toEqual([]);
  });
});
