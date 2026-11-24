import { describe, expect, it } from "vitest";

import { lotusMcpConfig, otherLotusOff } from "../codex-session";

describe("otherLotusOff", () => {
  const both = ["lotus", "lotus-dev", "context7"];

  it("turns off the other Lotus app's MCP server, and nothing without a profile", () => {
    expect(otherLotusOff("lotus-dev", both)).toEqual({ "mcp_servers.lotus.enabled": false });
    expect(otherLotusOff("lotus", both)).toEqual({ "mcp_servers.lotus-dev.enabled": false });
    expect(otherLotusOff(undefined, both)).toBeNull();
    expect(otherLotusOff("something-else", both)).toBeNull();
  });

  it("leaves a server that is not configured alone: turning it off fails the thread", () => {
    expect(otherLotusOff("lotus", ["lotus", "context7"])).toBeNull();
    expect(otherLotusOff("lotus-dev", [])).toBeNull();
  });
});

describe("lotusMcpConfig", () => {
  it("hands the chat's thread id to this app's own server, which Codex starts with a filtered env", () => {
    expect(lotusMcpConfig({ LOTUS_PROFILE_KEY: "lotus-dev", LOTUS_CHAT_THREAD_ID: "t1" }, ["lotus", "lotus-dev"])).toEqual({
      "mcp_servers.lotus.enabled": false,
      "mcp_servers.lotus-dev.env.LOTUS_CHAT_THREAD_ID": "t1",
    });
    expect(lotusMcpConfig({ LOTUS_PROFILE_KEY: "lotus", LOTUS_CHAT_THREAD_ID: "t1" }, ["lotus-dev"])).toEqual({ "mcp_servers.lotus-dev.enabled": false });
    expect(lotusMcpConfig({ LOTUS_PROFILE_KEY: "lotus" }, ["lotus"])).toBeNull();
  });
});

describe("otherLotusHidden (Claude)", () => {
  it("hides the other Lotus build's server, and nothing when the profile is unknown", async () => {
    const { otherLotusHidden } = await import("../claude-session");
    expect(otherLotusHidden("lotus-dev")).toEqual({ disallowedTools: ["mcp__lotus__*"] });
    expect(otherLotusHidden("lotus")).toEqual({ disallowedTools: ["mcp__lotus-dev__*"] });
    expect(otherLotusHidden(undefined)).toBeNull();
  });
});
