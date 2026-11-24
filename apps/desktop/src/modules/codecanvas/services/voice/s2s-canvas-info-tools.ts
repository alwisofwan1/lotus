import { resolveAgentByName, type IntentParamCtx } from "../canvas-nl-command";
import type { AgentStatusSnapshot } from "../agent-status-registry";
import type { AgentNodeStatus } from "../../types/canvas";
import type { RealtimeTool } from "./s2s-concierge-bridge";
import type { S2sToolCall } from "./s2s-stream-bridge";
import type { S2sCanvasToolResult } from "./s2s-canvas-tool-executor";
import type {
  CodeCanvasMemoryItem,
  CodeCanvasMemorySearchQuery,
  CodeCanvasMemorySearchResult,
  CodeCanvasMemoryWriteInput,
} from "@/lib/tauri/codecanvas";

/**
 * Read-back / awareness voice tools that sit ALONGSIDE the canvas-mutation tools in
 * {@link buildS2sCanvasRealtimeTools}. Unlike those, these do not flow through the synchronous
 * `NlEffect` executor — they answer a question (status, memory recall, agent output) or persist a
 * fact, and memory calls are async (Tauri `invoke`). The S2S bridge already awaits Promise-returning
 * tool handlers, so {@link executeS2sInfoToolCall} is async and its result is spoken via the `speak`
 * field just like the mutation tools (except read_agent_output, which leaves `speak` empty so the
 * model summarizes the raw terminal text carried in `summary`).
 */
export const S2S_INFO_TOOL_NAMES = ["agent_status", "remember", "recall", "read_agent_output"] as const;

/** Max characters of stripped terminal tail handed to the model to summarize. */
const OUTPUT_TAIL_CHARS = 1200;

const S2S_INFO_TOOL_SET = new Set<string>(S2S_INFO_TOOL_NAMES);

export function isS2sInfoTool(name: string): boolean {
  return S2S_INFO_TOOL_SET.has(name);
}

export interface S2sInfoToolDeps {
  /** Live agent snapshots (name + status + hookPaneId), read at call time so answers are current. */
  roster: AgentStatusSnapshot[];
  /** Active project id; required for memory tools. Null/undefined disables remember/recall. */
  projectId?: string | null;
  /** Injected Tauri memory writers/readers — kept as deps so the module stays pure + testable. */
  memoryWrite?: (input: CodeCanvasMemoryWriteInput) => Promise<CodeCanvasMemoryItem>;
  memorySearch?: (query: CodeCanvasMemorySearchQuery) => Promise<CodeCanvasMemorySearchResult[]>;
  /** Read an agent's pooled terminal transcript by its pane id (snapshot.hookPaneId). */
  readTranscript?: (paneId: string) => string | null;
}

const STATUS_PHRASE: Record<AgentNodeStatus, string> = {
  idle: "idle",
  connecting: "starting up",
  running: "working",
  "needs-you": "waiting for you",
  completed: "finished",
  error: "in an error state",
  stalled: "stalled",
};

const AGENT_STATUS_TOOL: RealtimeTool = {
  type: "function",
  name: "agent_status",
  description:
    "Report the live status of the agents on the canvas (idle, working, finished, stalled, error). " +
    "Use for questions like 'what is Rowan doing?', 'are the agents done?', or 'which agents are running?'. Read-only.",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "Optional agent name to report on. Omit to summarize all agents." },
    },
  },
};

const READ_AGENT_OUTPUT_TOOL: RealtimeTool = {
  type: "function",
  name: "read_agent_output",
  description:
    "Read an agent's most recent terminal output and report the gist. Use for 'what did Rowan find?', " +
    "'read me the agent's last output', 'what's on the Codex terminal?'. Read-only. The tool returns raw " +
    "terminal text in its summary — summarize it in one or two sentences; never read it verbatim.",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "Agent name to read. Omit only when there is exactly one agent." },
    },
  },
};

const REMEMBER_TOOL: RealtimeTool = {
  type: "function",
  name: "remember",
  description:
    "Save a durable note to this project's shared memory so it persists across sessions and is visible to the agents. " +
    "Use for 'remember that…', 'note that…', 'save this decision…'.",
  parameters: {
    type: "object",
    properties: {
      note: { type: "string", description: "The fact or decision to remember, stated in full." },
      title: { type: "string", description: "Optional short title for the note." },
    },
    required: ["note"],
  },
};

const RECALL_TOOL: RealtimeTool = {
  type: "function",
  name: "recall",
  description:
    "Search this project's shared memory and report what was found. " +
    "Use for 'what did we decide about…', 'what do we know about…', 'recall…'. Read-only.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up in project memory." },
    },
    required: ["query"],
  },
};

/** Advertise the awareness/memory tools, each gated on its precondition being present in ctx. */
export function buildS2sInfoTools(ctx: IntentParamCtx): RealtimeTool[] {
  const tools: RealtimeTool[] = [];
  if (ctx.agentNames.length > 0) tools.push(AGENT_STATUS_TOOL, READ_AGENT_OUTPUT_TOOL);
  if (ctx.hasProjectMemory) tools.push(REMEMBER_TOOL, RECALL_TOOL);
  return tools;
}

// Terminal-control strippers, built via new RegExp from \u escapes so NO raw control bytes appear in
// source (editors/writers strip literal control bytes, which would silently corrupt the patterns).
// OSC: ESC ] … terminated by BEL () or ST (ESC \). CSI: ESC/CSI-introducer … final byte.
const OSC_PATTERN = new RegExp("\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)", "g");
const CSI_PATTERN = new RegExp("[\\u001b\\u009b][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]", "g");
// Residual lone control bytes; range excludes tab (0x09) and newline (0x0a) so they survive.
const CTRL_PATTERN = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");

/** Strip ANSI/OSC/control bytes, collapse blank runs, and keep the last {@link OUTPUT_TAIL_CHARS}. */
function cleanTerminalTail(raw: string): string {
  const stripped = raw
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(/\r/g, "")
    .replace(CTRL_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.length > OUTPUT_TAIL_CHARS ? stripped.slice(stripped.length - OUTPUT_TAIL_CHARS) : stripped;
}

function naturalJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function statusPhrase(status: AgentNodeStatus): string {
  return STATUS_PHRASE[status] ?? status;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const match = trimmed.match(/^.*?[.!?](?=\s|$)/);
  const picked = (match?.[0] ?? trimmed).trim();
  return picked.length > 120 ? `${picked.slice(0, 117)}…` : picked;
}

/** Resolve a target name (or the sole agent) to a roster snapshot, or a spoken error. */
function resolveTargetAgent(
  target: string,
  roster: AgentStatusSnapshot[],
): AgentStatusSnapshot | { error: string; speak: string } {
  if (!target) {
    if (roster.length === 1) return roster[0];
    if (roster.length === 0) return { error: "No agents are running.", speak: "There are no agents running." };
    return { error: "Ambiguous agent.", speak: "Which agent — you have several running?" };
  }
  const resolved = resolveAgentByName(target, roster);
  if (!resolved.ok) return { error: `No agent named ${target}.`, speak: `I don't see an agent called ${target}.` };
  const agent = roster.find((candidate) => candidate.id === resolved.id);
  if (!agent) return { error: `No agent named ${target}.`, speak: `I don't see an agent called ${target}.` };
  return agent;
}

function agentStatus(call: S2sToolCall, deps: S2sInfoToolDeps): S2sCanvasToolResult {
  const target = str(call.args.target);
  const roster = deps.roster;
  if (!target) {
    if (roster.length === 0) return { ok: true, summary: "No agents running", speak: "No agents are running right now." };
    const parts = roster.map((agent) => `${agent.name} is ${statusPhrase(agent.status)}`);
    return { ok: true, summary: "Reported agent status", speak: `${naturalJoin(parts)}.` };
  }
  const resolved = resolveAgentByName(target, roster);
  if (!resolved.ok) {
    return { ok: false, error: `No agent named ${target}.`, speak: `I don't see an agent called ${target}.` };
  }
  const agent = roster.find((candidate) => candidate.id === resolved.id);
  if (!agent) return { ok: false, error: `No agent named ${target}.`, speak: `I don't see an agent called ${target}.` };
  return { ok: true, summary: `Status of ${agent.name}`, speak: `${agent.name} is ${statusPhrase(agent.status)}.` };
}

function readAgentOutput(call: S2sToolCall, deps: S2sInfoToolDeps): S2sCanvasToolResult {
  if (!deps.readTranscript) {
    return { ok: false, error: "Agent output is unavailable.", speak: "I can't read agent output here." };
  }
  const resolved = resolveTargetAgent(str(call.args.target), deps.roster);
  if ("error" in resolved) return { ok: false, error: resolved.error, speak: resolved.speak };

  const paneId = resolved.hookPaneId;
  if (!paneId) {
    return { ok: false, error: `${resolved.name} has no pane to read.`, speak: `I can't reach ${resolved.name}'s terminal.` };
  }
  const raw = deps.readTranscript(paneId);
  const tail = raw ? cleanTerminalTail(raw) : "";
  if (!tail) {
    return { ok: true, summary: `${resolved.name} has produced no output yet`, speak: `${resolved.name} hasn't produced any output yet.` };
  }
  // Empty `speak` is dropped by the bridge sanitizer, so the model receives only the terminal text in
  // `summary` and composes a spoken summary (per the tool description + system prompt).
  return { ok: true, summary: `${resolved.name} output:\n${tail}`, speak: "" };
}

async function remember(call: S2sToolCall, deps: S2sInfoToolDeps): Promise<S2sCanvasToolResult> {
  const note = str(call.args.note);
  if (!note) return { ok: false, error: "Nothing to remember.", speak: "What should I remember?" };
  if (!deps.projectId || !deps.memoryWrite) {
    return { ok: false, error: "Project memory is unavailable.", speak: "I can't save to memory here." };
  }
  const title = str(call.args.title);
  try {
    await deps.memoryWrite({
      projectId: deps.projectId,
      kind: "note",
      body: note,
      ...(title ? { title } : {}),
      source: "voice",
      actorKind: "human",
      tags: ["voice"],
    });
    return { ok: true, summary: `Remembered: ${title || firstSentence(note)}`, speak: "Got it — I'll remember that." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), speak: "I couldn't save that to memory." };
  }
}

async function recall(call: S2sToolCall, deps: S2sInfoToolDeps): Promise<S2sCanvasToolResult> {
  const query = str(call.args.query);
  if (!query) return { ok: false, error: "Nothing to look up.", speak: "What should I look up?" };
  if (!deps.projectId || !deps.memorySearch) {
    return { ok: false, error: "Project memory is unavailable.", speak: "I can't search memory here." };
  }
  try {
    const results = await deps.memorySearch({ projectId: deps.projectId, query, includeArchived: false, limit: 3 });
    if (results.length === 0) {
      return { ok: true, summary: `No memory for "${query}"`, speak: `I didn't find anything about ${query}.` };
    }
    const labels = results
      .map((result) => result.item.title?.trim() || result.item.summary?.trim() || firstSentence(result.item.body))
      .filter(Boolean);
    const speak =
      labels.length === 1 ? `I found: ${labels[0]}.` : `I found ${labels.length} — ${naturalJoin(labels)}.`;
    return { ok: true, summary: `Recalled ${results.length} for "${query}"`, speak };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), speak: "I couldn't search memory." };
  }
}

/** Execute an awareness/memory tool call. Async because memory tools hit Tauri `invoke`. */
export async function executeS2sInfoToolCall(call: S2sToolCall, deps: S2sInfoToolDeps): Promise<S2sCanvasToolResult> {
  switch (call.name) {
    case "agent_status":
      return agentStatus(call, deps);
    case "read_agent_output":
      return readAgentOutput(call, deps);
    case "remember":
      return remember(call, deps);
    case "recall":
      return recall(call, deps);
    default:
      return { ok: false, error: `Unknown info tool "${call.name}".`, speak: "I can't do that by voice yet." };
  }
}
