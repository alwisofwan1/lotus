/**
 * Voice-to-Voice "concierge" tool-bridge — pure mapping core.
 *
 * A pure S2S model (Grok / OpenAI Realtime) is the *voice front-end*, not the coding brain: it chats
 * and, when the user asks for work, calls a small set of tools that this bridge maps onto Lotus MCP
 * actions (spawn a cell, dispatch to an agent, list the fleet, focus a node). The actual coding is
 * done by the Lotus agents (Claude/Codex), preserving the product's premise — the realtime model
 * never writes code itself.
 *
 * This module is pure: it advertises the tool schema ({@link CONCIERGE_TOOLS}) to put in the
 * realtime `session.update`, and resolves an inbound tool call to an MCP dispatch
 * ({@link resolveConciergeAction}). The imperative hook performs the actual MCP call.
 */

export interface ConciergeTool {
  name: string;
  description: string;
  /** JSON-schema-ish parameter names → whether required (kept minimal; the realtime API takes JSON schema). */
  parameters: { name: string; required: boolean; description: string }[];
}

/** The tools the concierge may call. Names are stable; the hook forwards args to the mapped MCP tool. */
export const CONCIERGE_TOOLS: ConciergeTool[] = [
  {
    name: "spawn_agent",
    description: "Start a new Lotus agent to do a piece of work, described by a brief.",
    parameters: [
      { name: "brief", required: true, description: "What the new agent should do." },
      { name: "name", required: false, description: "Optional name for the agent." },
    ],
  },
  {
    name: "dispatch_to_agent",
    description: "Send a message/task to an existing Lotus agent by name.",
    parameters: [
      { name: "name", required: true, description: "The target agent's name." },
      { name: "message", required: true, description: "The message or task to send." },
    ],
  },
  {
    name: "list_agents",
    description: "List the agents currently on the canvas.",
    parameters: [],
  },
  {
    name: "focus_agent",
    description: "Pan/zoom the canvas to a specific agent so the user can watch it.",
    parameters: [{ name: "name", required: true, description: "The agent to focus." }],
  },
];

export interface ConciergeToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type ConciergeAction =
  | { kind: "dispatch"; mcpTool: string; args: Record<string, unknown> }
  | { kind: "unknown"; toolName: string };

/** Map a concierge tool name to its Lotus MCP tool. */
const TOOL_TO_MCP: Record<string, string> = {
  spawn_agent: "lotus_spawn_cell",
  dispatch_to_agent: "lotus_dispatch_to_cell",
  list_agents: "lotus_list_fleet",
  focus_agent: "lotus_focus_cell",
};

export function resolveConciergeAction(call: ConciergeToolCall): ConciergeAction {
  const mcpTool = TOOL_TO_MCP[call.name];
  if (!mcpTool) return { kind: "unknown", toolName: call.name };
  return { kind: "dispatch", mcpTool, args: call.args };
}

/** A tool in the OpenAI-Realtime `session.update.tools` schema (Grok speaks the same format). */
export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  /** OpenAI-Realtime-compatible JSON Schema object; may contain enums/nested arrays/objects. */
  parameters: Record<string, unknown>;
}

/** Convert the concierge tool set to the realtime `tools` array advertised in `session.update`. */
export function toRealtimeTools(tools: ConciergeTool[] = CONCIERGE_TOOLS): RealtimeTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        tool.parameters.map((p) => [p.name, { type: "string", description: p.description }]),
      ),
      required: tool.parameters.filter((p) => p.required).map((p) => p.name),
    },
  }));
}
