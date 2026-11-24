import { describe, it, expect } from "vitest";
import { buildLotusMcpConfig } from "../mcp-config.js";

describe("buildLotusMcpConfig", () => {
  it("builds a stdio lotus MCP server pointed at the discovery file", () => {
    const json = buildLotusMcpConfig({
      sidecarCommand: "bun",
      sidecarPath: "/app/mcp/lotus-mcp-server.mjs",
      discoveryPath: "/home/op/.lotus/lotus-mcp-ipc.json",
    });
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        lotus: {
          type: "stdio",
          command: "bun",
          args: ["/app/mcp/lotus-mcp-server.mjs", "--discovery", "/home/op/.lotus/lotus-mcp-ipc.json"],
        },
      },
    });
  });
});
