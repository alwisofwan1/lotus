import type { VoiceLiveTools } from "@/modules/voice-core/voice-adapter";
import type { AgentStatusSnapshot } from "@/modules/codecanvas/services/agent-status-registry";
import { resolveAgentByName } from "@/modules/codecanvas/services/canvas-nl-command";
import type { AgentNodeStatus } from "@/modules/codecanvas/types/canvas";
import type { RealtimeTool } from "@/modules/codecanvas/services/voice/s2s-concierge-bridge";
import type { S2sCanvasToolResult } from "@/modules/codecanvas/services/voice/s2s-canvas-tool-executor";
import { S2S_END_CONVERSATION_TOOL } from "@/modules/codecanvas/services/voice/s2s-end-conversation";
import { buildS2sInfoTools, executeS2sInfoToolCall, isS2sInfoTool } from "@/modules/codecanvas/services/voice/s2s-canvas-info-tools";
import type {
  CodeCanvasMemoryItem,
  CodeCanvasMemorySearchQuery,
  CodeCanvasMemorySearchResult,
  CodeCanvasMemoryWriteInput,
} from "@/lib/tauri/codecanvas";
import type { CodeVoicePane, CodeVoiceSendOutcome } from "./code-voice-adapter";
import type { PaneActivity } from "../types";

/**
 * Live Voice in Code (plans/composer-voice-ux ticket 10): the tools Lotus may call on the panes of
 * the folder on screen — focus a pane, tell an agent something, dispatch, spawn, report status, read
 * recent output, remember and recall.
 *
 * A message goes straight in, the way a typed Enter does: Live Voice is a conversation, and Lotus says
 * back what it sent. A close is different: a misheard close would kill a terminal session, so
 * `close_pane` only asks "Close Rowan?", and closes on a second call with `confirm` — honoured only
 * when it answers that question, for that pane, with no other tool in between. An agent that is
 * working or waiting for the user is never closed by voice. One pane at a time;
 * close_all is refused. Without a `close` dep there is no close at all, and a spoken close gets ⌘W.
 */

export const CODE_LIVE_VOICE_CLOSE_REPLY = "I can't close panes by voice — use ⌘W.";

export interface CodeLiveVoiceDeps {
  /** The panes of the folder on screen. */
  getPanes: () => CodeVoicePane[];
  focusedId: () => string | null;
  focus: (paneId: string) => void;
  /** Deliver to a pane the way a typed Enter would. */
  send: (paneId: string, text: string) => Promise<CodeVoiceSendOutcome>;
  /** The agents this machine can launch, by name. */
  launchable: () => string[];
  /** Open a new pane running that agent; its id, or null when it could not be opened. */
  spawn: (agent: string) => string | null;
  /** A terminal pane's recent output, raw. */
  readOutput?: (paneId: string) => string | null;
  /** The folder's project, for memory. Null/undefined = no remember/recall. */
  projectId?: string | null;
  memoryWrite?: (input: CodeCanvasMemoryWriteInput) => Promise<CodeCanvasMemoryItem>;
  memorySearch?: (query: CodeCanvasMemorySearchQuery) => Promise<CodeCanvasMemorySearchResult[]>;
  /** Close a pane as its × would (an Editor with unsaved edits still asks). Absent = no close by voice. */
  close?: (paneId: string) => void;
  /** The pane Lotus last asked "Close …?" about, until answered or the conversation moves on. */
  pendingClose?: { current: string | null };
}

type Result = S2sCanvasToolResult;
type Call = { name: string; args: Record<string, unknown> };

const STATUS_OF: Record<PaneActivity, AgentNodeStatus> = {
  offline: "idle",
  starting: "connecting",
  idle: "idle",
  working: "running",
  "needs-you": "needs-you",
  failed: "error",
  done: "completed",
};

/** What the user calls the pane: a terminal's handle ("Soren") over its title ("Test functionality"). */
function spokenName(pane: CodeVoicePane): string {
  return pane.persona || pane.name;
}

function isAgent(pane: CodeVoicePane): boolean {
  return pane.kind === "thread" || (pane.kind === "terminal" && pane.agent !== false);
}

/** The panes an agent runs in — what "tell …", status and output are about. A plain shell is not one. */
function agentRoster(panes: CodeVoicePane[]): AgentStatusSnapshot[] {
  return panes
    .filter(isAgent)
    .map((pane) => ({ id: pane.id, name: spokenName(pane), status: pane.activity ? STATUS_OF[pane.activity] : "idle", hookPaneId: pane.id }));
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const TARGET = { type: "string", description: "The pane's name." };

function paneTools(agentNames: string[], paneNames: string[], launchable: string[], canClose: boolean): RealtimeTool[] {
  const tools: RealtimeTool[] = [];
  if (paneNames.length > 0) {
    tools.push({
      type: "function",
      name: "focus",
      description: "Bring a pane to the front and give it the keyboard. Use for 'show me Rowan', 'go to the docs pane'.",
      parameters: { type: "object", properties: { target: { ...TARGET, enum: paneNames } }, required: ["target"] },
    });
  }
  if (agentNames.length > 0) {
    const target = { ...TARGET, enum: agentNames, description: "The agent's name. Omit to use the focused agent." };
    tools.push(
      {
        type: "function",
        name: "say_to_agent",
        description: "Pass a short message to one agent, as if the user typed it in that agent's pane. Use for 'tell Rowan …', 'ask Codex …'.",
        parameters: { type: "object", properties: { target, message: { type: "string", description: "What to tell the agent, in full." } }, required: ["message"] },
      },
      {
        type: "function",
        name: "dispatch",
        description: "Give one agent a piece of work. Use for 'have Rowan review the auth module', 'get Codex to fix the build'.",
        parameters: { type: "object", properties: { target, task: { type: "string", description: "The task, stated in full with every constraint the user said." } }, required: ["task"] },
      },
    );
  }
  if (canClose && paneNames.length > 0) {
    tools.push({
      type: "function",
      name: "close_pane",
      description: "Close one pane. The first call only asks the user to confirm; call again with confirm: true once the user has said yes.",
      parameters: {
        type: "object",
        properties: {
          target: { ...TARGET, enum: paneNames },
          confirm: { type: "boolean", description: "True only when the user has just said yes to closing this pane." },
        },
        required: ["target"],
      },
    });
  }
  if (launchable.length > 0) {
    tools.push({
      type: "function",
      name: "spawn_agent",
      description: "Open a new pane running an agent CLI. It takes a few seconds to start; give it work with dispatch once it is ready.",
      parameters: { type: "object", properties: { agent: { type: "string", enum: launchable, description: "Which agent to start." } }, required: ["agent"] },
    });
  }
  return tools;
}

function describePane(pane: CodeVoicePane): string {
  const title = spokenName(pane) === pane.name ? "" : ` — "${pane.name}"`;
  const runs = pane.runner ? `, runs ${pane.runner}` : "";
  const kind = pane.kind === "terminal" ? (isAgent(pane) ? `terminal agent${runs}` : "plain shell, not an agent") : pane.kind;
  return `- ${spokenName(pane)}${title} (${kind})`;
}

function instructionsFor(panes: CodeVoicePane[], focused: CodeVoicePane | undefined, launchable: string[], canClose: boolean): string {
  const roster = panes.length
    ? panes.map(describePane).join("\n")
    : "- none open";
  return [
    "You are Lotus, the voice of the user's Code workspace: a grid of panes, each a terminal agent, a chat thread, a browser or an editor.",
    "Keep replies to one or two short spoken sentences. Act with a tool when the user asks for something; say what you did.",
    `Panes open now:\n${roster}`,
    focused ? `The focused pane is ${spokenName(focused)}.` : "No pane has focus.",
    launchable.length
      ? `Agent CLIs you can start in a new pane: ${launchable.join(", ")}. These are not open panes; count and name only the panes above.`
      : "No agent CLI is installed to start.",
    "Messages and tasks go to the agent straight away, so pass the user's words faithfully; never invent a task.",
    canClose
      ? "To close a pane, call close_pane with its name, and say what it returns. A busy agent cannot be closed by voice. Only when the user answers yes, call close_pane again with the same name and confirm: true. One pane at a time; you cannot close everything at once."
      : `You cannot close panes. When asked to close one, say exactly: "${CODE_LIVE_VOICE_CLOSE_REPLY}"`,
  ].join("\n\n");
}

function canClose(deps: CodeLiveVoiceDeps): boolean {
  return Boolean(deps.close && deps.pendingClose);
}

function hasProjectMemory(deps: CodeLiveVoiceDeps): boolean {
  return Boolean(deps.projectId && deps.memoryWrite && deps.memorySearch);
}

/**
 * Everything the advertised tools and instructions are built from, as one comparable string: the
 * provider is told again only when this changes. Pane activity is left out on purpose — status is
 * read when it is asked for, and agents flip between working and idle all the time.
 */
export function codeLiveVoiceContextKey(deps: CodeLiveVoiceDeps): string {
  return JSON.stringify({
    panes: deps.getPanes().map((pane) => [pane.id, pane.name, pane.persona, pane.kind, pane.agent, pane.runner]),
    focused: deps.focusedId(),
    launchable: deps.launchable(),
    memory: hasProjectMemory(deps),
    close: canClose(deps),
  });
}

export function createCodeLiveVoiceTools(deps: CodeLiveVoiceDeps): VoiceLiveTools {
  const panes = deps.getPanes();
  const roster = agentRoster(panes);
  const launchable = deps.launchable();
  const infoTools = buildS2sInfoTools({ nodeKinds: [], agentNames: roster.map((agent) => agent.name), hasProjectMemory: hasProjectMemory(deps) });
  const tools = [...paneTools(roster.map((agent) => agent.name), panes.map(spokenName), launchable, canClose(deps)), ...infoTools, S2S_END_CONVERSATION_TOOL];
  const focused = panes.find((pane) => pane.id === deps.focusedId());

  return {
    instructions: instructionsFor(panes, focused, launchable, canClose(deps)),
    tools,
    execute: (call) => executeCodeLiveVoiceTool(call, deps),
  };
}

/** A pane by the name said — its handle first, then its title; an error to speak otherwise. */
function resolvePane(target: string, panes: CodeVoicePane[], what: string): CodeVoicePane | Result {
  for (const nameOf of [spokenName, (pane: CodeVoicePane) => pane.name]) {
    const resolved = resolveAgentByName(target, panes.map((pane) => ({ id: pane.id, name: nameOf(pane), status: "idle" as const })));
    const pane = resolved.ok ? panes.find((candidate) => candidate.id === resolved.id) : undefined;
    if (pane) return pane;
  }
  return { ok: false, error: `No ${what} named ${target}.`, speak: `I don't see ${what === "pane" ? "a pane" : "an agent"} called ${target}.` };
}

/** The agent a message is for: the one named, else the focused agent, else the only one. */
function messageTarget(target: string, panes: CodeVoicePane[], focusedId: string | null): AgentStatusSnapshot | Result {
  const roster = agentRoster(panes);
  if (target) {
    const pane = resolvePane(target, panes.filter(isAgent), "agent");
    return "ok" in pane ? pane : roster.find((agent) => agent.id === pane.id)!;
  }
  const focused = roster.find((agent) => agent.id === focusedId);
  if (focused) return focused;
  if (roster.length === 1) return roster[0];
  if (roster.length === 0) return { ok: false, error: "No agents are open.", speak: "There's no agent open to tell." };
  return { ok: false, error: "Ambiguous agent.", speak: "Which agent?" };
}

async function sendToAgent(call: Call, deps: CodeLiveVoiceDeps, field: "message" | "task"): Promise<Result> {
  const text = trimmed(call.args[field]);
  if (!text) return { ok: false, error: `No ${field}.`, speak: field === "task" ? "What should they do?" : "What should I tell them?" };
  const agent = messageTarget(trimmed(call.args.target), deps.getPanes(), deps.focusedId());
  if ("ok" in agent) return agent;
  const outcome = await deps.send(agent.id, text);
  if (!outcome.ok) return { ok: false, error: outcome.reason, speak: `I couldn't reach ${agent.name}: ${outcome.reason}` };
  return { ok: true, summary: `Sent to ${agent.name}`, speak: `Sent to ${agent.name}.` };
}

function focus(call: Call, deps: CodeLiveVoiceDeps): Result {
  const target = trimmed(call.args.target);
  if (!target) return { ok: false, error: "No pane named.", speak: "Which pane?" };
  const pane = resolvePane(target, deps.getPanes(), "pane");
  if ("ok" in pane) return pane;
  deps.focus(pane.id);
  return { ok: true, summary: `Focused ${spokenName(pane)}`, speak: `${spokenName(pane)} is in front.` };
}

function spawn(call: Call, deps: CodeLiveVoiceDeps): Result {
  const said = trimmed(call.args.agent).toLowerCase();
  const launchable = deps.launchable();
  const agent = launchable.find((name) => name.toLowerCase() === said) ?? launchable.find((name) => said && name.toLowerCase().includes(said));
  if (!agent) {
    const choices = launchable.length ? ` I can start ${launchable.join(" or ")}.` : "";
    return { ok: false, error: `Cannot launch ${said || "that"}.`, speak: `I can't start ${trimmed(call.args.agent) || "that"} here.${choices}` };
  }
  if (!deps.spawn(agent)) return { ok: false, error: `Could not open ${agent}.`, speak: `I couldn't open ${agent}.` };
  return { ok: true, summary: `Started ${agent}`, speak: `Starting ${agent}.` };
}

function closePane(call: Call, deps: CodeLiveVoiceDeps): Result {
  const { close, pendingClose } = deps;
  if (!close || !pendingClose) return { ok: false, error: "Closing panes by voice is off in Code.", speak: CODE_LIVE_VOICE_CLOSE_REPLY };
  const target = trimmed(call.args.target);
  if (!target) return { ok: false, error: "No pane named.", speak: "Which pane?" };
  const pane = resolvePane(target, deps.getPanes(), "pane");
  if ("ok" in pane) return pane;
  const name = spokenName(pane);
  // The close guard asks only for unsaved Editor edits, so nothing else would stop a misheard yes
  // from killing an agent mid-task. Checked on the yes too: it may have started since the question.
  if (pane.activity === "working" || pane.activity === "needs-you") {
    pendingClose.current = null;
    return { ok: false, error: `${name} is busy.`, speak: `${name} is still working — wait until it finishes, or use ⌘W.` };
  }
  if (call.args.confirm !== true || pendingClose.current !== pane.id) {
    pendingClose.current = pane.id;
    return { ok: true, summary: `Asked to close ${name}`, speak: `Close ${name}? Say yes to close it.` };
  }
  pendingClose.current = null;
  close(pane.id);
  return { ok: true, summary: `Closed ${name}`, speak: `Closed ${name}.` };
}

/** Runs one Live Voice tool call against the panes. Never throws: a failure is a spoken error. */
export async function executeCodeLiveVoiceTool(call: Call, deps: CodeLiveVoiceDeps): Promise<Result> {
  // A "Close …?" is answered by the next close_pane, or not at all.
  if (call.name !== "close_pane" && deps.pendingClose) deps.pendingClose.current = null;
  try {
    return await runTool(call, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, speak: "That didn't work." };
  }
}

async function runTool(call: Call, deps: CodeLiveVoiceDeps): Promise<Result> {
  switch (call.name) {
    case "focus":
      return focus(call, deps);
    case "say_to_agent":
      return sendToAgent(call, deps, "message");
    case "dispatch":
      return sendToAgent(call, deps, "task");
    case "spawn_agent":
      return spawn(call, deps);
    case "close_pane":
      return closePane(call, deps);
    case "close":
    case "close_all":
      return canClose(deps)
        ? { ok: false, error: "Closes one pane at a time.", speak: "I close one pane at a time — which one?" }
        : { ok: false, error: "Closing panes by voice is off in Code.", speak: CODE_LIVE_VOICE_CLOSE_REPLY };
  }
  if (isS2sInfoTool(call.name)) {
    return executeS2sInfoToolCall(
      { callId: "", name: call.name, args: call.args },
      {
        roster: agentRoster(deps.getPanes()),
        projectId: deps.projectId,
        memoryWrite: deps.memoryWrite,
        memorySearch: deps.memorySearch,
        readTranscript: deps.readOutput,
      },
    );
  }
  return { ok: false, error: `Unknown tool "${call.name}".`, speak: "I can't do that by voice in Code." };
}
