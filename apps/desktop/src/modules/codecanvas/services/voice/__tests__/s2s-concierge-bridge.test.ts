import { describe, expect, it } from "vitest";
import { CONCIERGE_TOOLS, resolveConciergeAction, toRealtimeTools } from "../s2s-concierge-bridge";

describe("resolveConciergeAction", () => {
  it("maps spawn_agent to the lotus_spawn_cell MCP tool", () => {
    const action = resolveConciergeAction({
      name: "spawn_agent",
      args: { brief: "review the PR", name: "Nova" },
    });
    expect(action).toEqual({
      kind: "dispatch",
      mcpTool: "lotus_spawn_cell",
      args: { brief: "review the PR", name: "Nova" },
    });
  });

  it("maps dispatch_to_agent, list_agents and focus_agent to their MCP tools", () => {
    expect(resolveConciergeAction({ name: "dispatch_to_agent", args: { name: "Nova", message: "go" } })).toEqual({
      kind: "dispatch",
      mcpTool: "lotus_dispatch_to_cell",
      args: { name: "Nova", message: "go" },
    });
    expect(resolveConciergeAction({ name: "list_agents", args: {} })).toEqual({
      kind: "dispatch",
      mcpTool: "lotus_list_fleet",
      args: {},
    });
    expect(resolveConciergeAction({ name: "focus_agent", args: { name: "Nova" } })).toEqual({
      kind: "dispatch",
      mcpTool: "lotus_focus_cell",
      args: { name: "Nova" },
    });
  });

  it("reports an unknown tool instead of dispatching a bogus MCP call", () => {
    expect(resolveConciergeAction({ name: "launch_missiles", args: {} })).toEqual({
      kind: "unknown",
      toolName: "launch_missiles",
    });
  });
});

describe("CONCIERGE_TOOLS", () => {
  it("advertises the concierge tools by name so the realtime session can call them", () => {
    const names = CONCIERGE_TOOLS.map((t) => t.name);
    expect(names).toContain("spawn_agent");
    expect(names).toContain("dispatch_to_agent");
  });
});

describe("toRealtimeTools", () => {
  it("converts a concierge tool to the OpenAI-Realtime function schema", () => {
    const spawn = toRealtimeTools([
      {
        name: "spawn_agent",
        description: "Start an agent.",
        parameters: [
          { name: "brief", required: true, description: "What to do." },
          { name: "name", required: false, description: "Optional name." },
        ],
      },
    ])[0];
    expect(spawn).toEqual({
      type: "function",
      name: "spawn_agent",
      description: "Start an agent.",
      parameters: {
        type: "object",
        properties: {
          brief: { type: "string", description: "What to do." },
          name: { type: "string", description: "Optional name." },
        },
        required: ["brief"],
      },
    });
  });
});
