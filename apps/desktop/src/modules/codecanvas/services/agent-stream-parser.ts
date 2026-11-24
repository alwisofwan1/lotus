import type { AgentRunUsage } from "./agent-run-record";

export type AgentStreamEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "result"; ok: boolean; text?: string; usage?: AgentRunUsage }
  | { kind: "exit"; code: number };

interface AssistantBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function toolLabel(name: string, input: Record<string, unknown>): string {
  if (name === "Read" && typeof input.file_path === "string") return `Reading ${input.file_path}`;
  if (name === "Edit" && typeof input.file_path === "string") return `Editing ${input.file_path}`;
  if (name === "Write" && typeof input.file_path === "string") return `Writing ${input.file_path}`;
  if (name === "Bash" && typeof input.command === "string") return `Running: ${input.command}`;
  return `Using ${name}`;
}

function parseUsage(
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
  costUsd: number | undefined,
): AgentRunUsage | null {
  if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return null;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof costUsd === "number" ? { costUsd } : {}),
  };
}

/** Parses one NDJSON line from a `claude-stream-json` run into a lean Agent event, or null to skip. */
export function parseAgentStreamLine(line: string): AgentStreamEvent | null {
  let json: {
    type?: string;
    message?: { content?: AssistantBlock[] };
    session_id?: string;
    is_error?: boolean;
    result?: string;
    exitCode?: number | null;
    text?: string;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  switch (json.type) {
    case "assistant": {
      const blocks = json.message?.content ?? [];
      const tool = blocks.find((b) => b.type === "tool_use");
      if (tool?.name) return { kind: "tool", label: toolLabel(tool.name, tool.input ?? {}) };
      const text = blocks.find((b) => b.type === "text")?.text;
      return text ? { kind: "text", text } : null;
    }
    case "system":
      return json.session_id ? { kind: "session", sessionId: json.session_id } : null;
    case "result": {
      const usage = parseUsage(json.usage, json.total_cost_usd);
      return { kind: "result", ok: !json.is_error, text: json.result, ...(usage ? { usage } : {}) };
    }
    case "_error":
      return { kind: "result", ok: false, text: json.text };
    case "_final":
      return { kind: "exit", code: json.exitCode ?? 0 };
    default:
      return null;
  }
}
