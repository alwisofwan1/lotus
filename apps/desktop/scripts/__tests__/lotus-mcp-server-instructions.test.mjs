import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __testables, SERVER_INSTRUCTIONS } from "../lotus-mcp-server.mjs";

// Claude Code defers MCP tools; the handshake instructions are what points it at Lotus panes.
describe("lotus MCP server instructions", () => {
  it("are sent in the initialize handshake", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await __testables.buildServer().connect(serverSide);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    const text = client.getInstructions();
    expect(text).toBe(SERVER_INSTRUCTIONS);
    expect(text).toContain("lotus_list_fleet");
    expect(text).toContain("lotus_dispatch_to_cell");
    expect(text).toContain("ListAgents");
    expect(text.length).toBeLessThan(2048);
    await client.close();
  });
});
