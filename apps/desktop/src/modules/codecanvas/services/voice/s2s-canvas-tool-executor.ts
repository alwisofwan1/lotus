import { buildRealtimeToolDefs, parseNlIntents } from "../canvas-nl-parse";
import {
  resolveNlIntent,
  resolveNlIntents,
  summarizeResolutions,
  MAX_NL_SPAWN_COUNT,
  parseNlSpawnCount,
  type NlCanvasIntent,
  type NlCommandContext,
  type NlClarifySeed,
} from "../canvas-nl-command";
import { executeNlEffect, type NlEffectExecutor } from "../canvas-nl-runner";
import type { IntentParamCtx } from "../canvas-nl-command";
import { runnerDisplayLabel } from "../canvas-agent-aliases";
import { meaningfulSpawnBrief } from "./spawn-brief-guard";
import { S2S_CHOOSE_TARGET_TOOL } from "./s2s-voice-clarification";
import { S2S_END_CONVERSATION_TOOL } from "./s2s-end-conversation";
import { assessS2sVoiceAgentTargetConfidence } from "./s2s-voice-target-confidence";
import type { RealtimeTool } from "./s2s-concierge-bridge";
import type { S2sToolCall } from "./s2s-stream-bridge";

export const S2S_CANVAS_TOOL_NAMES = [
  "create_node",
  "spawn_agent",
  "dispatch",
  "say_to_agent",
  "close",
  "close_all",
  "focus",
  "arrange",
  "draw_diagram",
  "open_browser",
  "navigate_browser",
  // Tier 1 parity: non-destructive intents the typed NL bar already ships. `close_project` is
  // intentionally omitted — it is destructive and would be blocked at execution anyway.
  "snapshot_browser",
  "run_task",
  "recover",
  "make_lead",
  "switch_project",
  "open_page",
  "new_project",
] as const;

const S2S_CANVAS_TOOL_SET = new Set<string>(S2S_CANVAS_TOOL_NAMES);

export type S2sCanvasToolResult =
  | {
      ok: true;
      summary: string;
      speak: string;
      nodeId?: string;
      queued?: boolean;
      delivery?: "queued" | "written";
    }
  | { ok: false; error: string; speak?: string; clarify?: NlClarifySeed & { question: string } };

function realtimeToolAvailable(name: string, ctx: IntentParamCtx): boolean {
  if (!S2S_CANVAS_TOOL_SET.has(name)) return false;
  // Live-agent tools need at least one agent to target.
  if ((name === "dispatch" || name === "say_to_agent" || name === "make_lead") && ctx.agentNames.length === 0) return false;
  // Browser tools need a browser node on the board.
  if ((name === "navigate_browser" || name === "snapshot_browser") && !ctx.hasBrowserNodes) return false;
  // switch_project grounds on an enum of open project names — hide it until there is somewhere to go.
  if (name === "switch_project" && !(ctx.projectNames && ctx.projectNames.length > 0)) return false;
  return true;
}

const PROFILE_WRAPPER_RUNNER_NAMES = new Set(["ccs", "csp"]);
function isProfileWrapperRunnerName(value: string): boolean {
  return PROFILE_WRAPPER_RUNNER_NAMES.has(value.trim().toLowerCase());
}

function withoutProfileWrapperRunnerNames(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && !isProfileWrapperRunnerName(value)) : [];
}

function withS2sCloseDescription(tool: RealtimeTool): RealtimeTool {
  if (tool.name === "close") {
    return {
      ...tool,
      description:
        'Close visible canvas nodes without confirmation. Use a string target for one named node, or target {"kind":"byType","nodeType":"agent"|"browser"|"music"|...,"quantifier":"all"} for close all agents/browsers/music.',
    };
  }
  if (tool.name === "close_all") {
    return { ...tool, description: "Close everything on the canvas without confirmation. Use only for explicit close everything / close semua requests." };
  }
  return tool;
}

function withS2sSpawnBatchSchema(tool: RealtimeTool): RealtimeTool {
  if (tool.name !== "spawn_agent") return tool;
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object") return tool;
  const runner = (properties as Record<string, unknown>).runner;
  const runnerEnum = runner && typeof runner === "object" ? withoutProfileWrapperRunnerNames((runner as { enum?: unknown }).enum) : [];
  const runnerProperty = runner && typeof runner === "object" ? { ...(runner as Record<string, unknown>), enum: runnerEnum } : runner;
  return {
    ...tool,
    description:
      "Launch one or multiple agents. For a single runner, set runner + optional count. For mixed requests like 'two Claude and three Codex', prefer one call with items.",
    parameters: {
      ...tool.parameters,
      properties: {
        ...(properties as Record<string, unknown>),
        runner: runnerProperty,
        count: { type: "integer", minimum: 1, maximum: MAX_NL_SPAWN_COUNT, description: "How many agents of this runner to open. Defaults to 1." },
        items: {
          type: "array",
          description: "Grouped multi-runner spawn request, e.g. [{runner:'claude',count:2},{runner:'codex',count:3}]. Prefer this for mixed-runner requests.",
          items: {
            type: "object",
            properties: {
              runner: { ...(runnerProperty && typeof runnerProperty === "object" ? runnerProperty : { type: "string" }), description: "Runner/CLI for this group." },
              count: { type: "integer", minimum: 1, maximum: MAX_NL_SPAWN_COUNT, description: "How many agents to open for this runner." },
              model: { type: "string", description: "Optional model id to pin for this group." },
              brief: { type: "string", description: "Optional first task for this group." },
            },
            required: ["runner", "count"],
          },
        },
      },
    },
  };
}

function withS2sDispatchSchema(tool: RealtimeTool): RealtimeTool {
  if (tool.name !== "dispatch") return tool;
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object") return tool;
  const rest = { ...(properties as Record<string, unknown>) };
  delete rest.task;
  return {
    ...tool,
    description:
      "Send a message to a live agent by name — the message goes straight to the agent's terminal (the chat). A message addressed to an agent (e.g. \"Rowan, …\" or \"ask Sage …\"), including a plain question, is ALWAYS a dispatch — never an error. Pass a short intent plus any explicit constraints; the app appends the user's verbatim request automatically.",
    parameters: {
      ...tool.parameters,
      properties: {
        ...rest,
        intent: {
          type: "string",
          description:
            "One short sentence naming the action and object, in the user's language. A label — never a transcript copy; the app attaches the user's verbatim words itself.",
        },
        key_constraints: {
          type: "array",
          items: { type: "string" },
          description:
            "Explicit boundaries or negations the user stated (e.g. 'analysis only, don't change code'). Empty if none.",
        },
      },
      required: ["target", "intent"],
    },
  };
}

export function buildS2sCanvasRealtimeTools(ctx: IntentParamCtx): RealtimeTool[] {
  const tools = buildRealtimeToolDefs(ctx)
    .filter((tool): tool is RealtimeTool => realtimeToolAvailable(tool.name, ctx))
    .map(withS2sCloseDescription)
    .map(withS2sSpawnBatchSchema)
    .map(withS2sDispatchSchema);
  // `end_conversation` is a session-control tool, not a canvas mutation: always advertised so the user
  // can end Live Voice hands-free by natural sign-off in any language. `choose_target` stays gated on
  // an in-flight clarification.
  const withEnd = [...tools, S2S_END_CONVERSATION_TOOL];
  return ctx.hasPendingClarification ? [...withEnd, S2S_CHOOSE_TARGET_TOOL] : withEnd;
}

export function resolveSocialAgentMessage(task: string, target: string): string | null {
  const text = task.trim();
  const wrapped = text.match(/^(?:sampaikan\s+salam|kirim\s+salam|ucapkan\s+salam|say\s+hello|send\s+hello)\s*[:,-]?\s*(.+)$/i);
  if (wrapped?.[1]?.trim()) return wrapped[1].trim();
  if (/^(?:hello|halo|hi|hai|hey)\b/i.test(text) && text.length <= 80) return text;
  if (/^(?:sampaikan\s+salam|kirim\s+salam|ucapkan\s+salam|say\s+hello|send\s+hello)\s*$/i.test(text)) return `Hello, ${target}!`;
  return null;
}

function normalizeSpawnRunner(value: unknown): unknown {
  return typeof value === "string" && isProfileWrapperRunnerName(value) ? "claude" : value;
}

function spawnItemsFromArgs(args: Record<string, unknown>): Array<Record<string, unknown>> | { error: string } {
  const rawItems = Array.isArray(args.items) ? args.items : null;
  const specs = rawItems
    ? rawItems.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : {}))
    : [args];
  const intents: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    const count = parseNlSpawnCount(spec.count);
    if (typeof count === "object") return count;
    for (let i = 0; i < count; i++) {
      intents.push({
        action: "spawn_agent",
        runner: normalizeSpawnRunner(spec.runner),
        ...(typeof spec.model === "string" && spec.model.trim() ? { model: spec.model.trim() } : {}),
        // A brief is auto-submitted verbatim as the agent's first prompt, so one that merely
        // restates the spawn request makes the new agent burn a real model turn on nonsense.
        // See `spawn-brief-guard.ts`.
        ...(() => {
          const runner = normalizeSpawnRunner(spec.runner);
          const brief =
            typeof spec.brief === "string"
              ? meaningfulSpawnBrief(spec.brief, typeof runner === "string" ? runner : undefined)
              : null;
          return brief ? { brief } : {};
        })(),
      });
    }
  }
  if (intents.length > MAX_NL_SPAWN_COUNT) return { error: `I can open up to ${MAX_NL_SPAWN_COUNT} agents at once.` };
  return intents;
}

function parseToolIntents(call: Pick<S2sToolCall, "name" | "args">): NlCanvasIntent[] | { error: string } {
  if (!S2S_CANVAS_TOOL_SET.has(call.name)) {
    return { error: `Realtime voice tool "${call.name}" is not allowed.` };
  }
  const args = { ...call.args };
  // Safety net: the realtime schema no longer advertises `task` for dispatch (Part 2 above), and the
  // controller normally compiles `intent` into `args.task` before this runs (Part 3). If a call somehow
  // arrives with only `intent`, fall back to it so `parseNlIntents`' dispatch parser (which requires a
  // `task` string) still resolves instead of erroring.
  if (call.name === "dispatch" && typeof args.task !== "string" && typeof args.intent === "string" && args.intent.trim()) {
    args.task = args.intent;
  }
  const raw = call.name === "spawn_agent" ? spawnItemsFromArgs(args) : [{ action: call.name, ...args }];
  if ("error" in raw) return raw;
  const parsed = parseNlIntents(JSON.stringify(raw));
  if ("error" in parsed) return parsed;
  if ("answer" in parsed) return { error: "Realtime voice tools must produce an action, not an answer." };
  if (parsed.length !== raw.length) return { error: "Realtime voice tool expansion did not resolve cleanly." };
  return parsed.map((intent) => {
    if (intent.action === "dispatch") {
      const message = resolveSocialAgentMessage(intent.task, intent.target);
      if (message) return { action: "say_to_agent", target: intent.target, message };
    }
    return intent;
  });
}

function summaryObject(summary: string): string {
  return summary.replace(/^(Create a |Spawn a |Spawn an |Draw a diagram of |Dispatch to |Say to |Focus |Close |Arrange the )/i, "").trim();
}

function naturalList(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

function clarifyResult(seed: NlClarifySeed): NlClarifySeed & { question: string } {
  const labels = seed.candidates.map((candidate) => candidate.label);
  return {
    ...seed,
    question: `Which ${seed.ambiguousName} — ${naturalList(labels)}?`,
  };
}

function mediumConfidenceClarify(intent: NlCanvasIntent, ctx: NlCommandContext): S2sCanvasToolResult | null {
  if (intent.action !== "dispatch" && intent.action !== "say_to_agent") return null;
  const confidence = assessS2sVoiceAgentTargetConfidence(intent.target, ctx);
  if (confidence.level !== "medium") return null;
  const clarify = {
    ambiguousName: intent.target,
    candidates: [{ id: confidence.label, label: confidence.label }],
    question: `Did you mean ${confidence.label}?`,
  };
  return {
    ok: false,
    error: `Confirm target ${confidence.label}.`,
    speak: clarify.question,
    clarify,
  };
}

function speakForCloseSummary(summary: string): string {
  if (/^Closing\s+/i.test(summary)) return `${summary.replace(/^Closing/i, "Closed")}.`;
  return `Closed ${summaryObject(summary)}.`;
}

function speakForSpawnSummary(summary: string): string {
  if (/^Spawning\s+/i.test(summary)) return `${summary.replace(/^Spawning/i, "I’m opening")}.`;
  return `I’m opening ${summaryObject(summary)}.`;
}

function executeBatchIntents(intents: NlCanvasIntent[], ctx: NlCommandContext, exec: NlEffectExecutor): S2sCanvasToolResult {
  const resolutions = resolveNlIntents(intents, ctx);
  if ("error" in resolutions) {
    if (resolutions.clarify) {
      const clarify = clarifyResult(resolutions.clarify);
      return { ok: false, error: resolutions.error, speak: clarify.question, clarify };
    }
    return { ok: false, error: resolutions.error, speak: "I couldn’t complete that batch." };
  }

  let nodeId: string | undefined;
  let queued = false;
  for (const resolution of resolutions) {
    if (resolution.destructive) return { ok: false, error: `Realtime voice cannot run destructive action: ${resolution.summary}.`, speak: "That one needs confirmation in the command bar." };
    const outcome = executeNlEffect(resolution.effect, exec);
    if (outcome.command?.error) return { ok: false, error: outcome.command.error, speak: "That command failed." };
    if (outcome.appDelivered === false) return { ok: false, error: `${resolution.summary} is not available here.`, speak: "That action isn’t available here." };
    if (outcome.send && outcome.send.delivered.length === 0 && outcome.send.queued.length === 0) {
      return { ok: false, error: `${resolution.summary} — agent isn't running yet.`, speak: "That agent isn’t running yet." };
    }
    queued = queued || Boolean(outcome.send?.queued.length);
    nodeId = nodeId ?? outcome.command?.nodeId;
  }

  const summary = summarizeResolutions(resolutions).trace;
  const allSpawn = intents.every((intent) => intent.action === "spawn_agent");
  return { ok: true, summary, speak: allSpawn ? speakForSpawnSummary(summary) : summarizeResolutions(resolutions).speak, ...(nodeId ? { nodeId } : {}), ...(queued ? { queued } : {}) };
}

function executeCloseIntent(intent: Extract<NlCanvasIntent, { action: "close" }>, ctx: NlCommandContext, exec: NlEffectExecutor): S2sCanvasToolResult {
  const resolutions = resolveNlIntents([intent], ctx);
  if ("error" in resolutions) {
    if (resolutions.clarify) {
      const clarify = clarifyResult(resolutions.clarify);
      return { ok: false, error: resolutions.error, speak: clarify.question, clarify };
    }
    return { ok: false, error: resolutions.error, speak: "I couldn’t find that target." };
  }

  let nodeId: string | undefined;
  for (const resolution of resolutions) {
    const outcome = executeNlEffect(resolution.effect, exec);
    if (outcome.command?.error) return { ok: false, error: outcome.command.error, speak: "That command failed." };
    nodeId = nodeId ?? outcome.command?.nodeId;
  }

  const summary = summarizeResolutions(resolutions).trace;
  return { ok: true, summary, speak: speakForCloseSummary(summary), ...(nodeId ? { nodeId } : {}) };
}

function speakForSuccess(intent: NlCanvasIntent, summary: string, ctx: NlCommandContext): string {
  switch (intent.action) {
    case "spawn_agent": {
      const runner = runnerDisplayLabel(intent.runnerLabel ?? intent.runner);
      return intent.brief ? `I’m opening a ${runner} agent for that.` : `I’m opening a ${runner} agent.`;
    }
    case "draw_diagram":
      return `I’m drawing the ${intent.topic} now.`;
    case "dispatch": {
      const agent = ctx.roster.find((candidate) => candidate.name === summaryObject(summary))?.name ?? summaryObject(summary);
      return `I sent that to ${agent}.`;
    }
    case "say_to_agent": {
      const agent = summaryObject(summary);
      return /^(?:hello|halo|hi|hai|hey)\b/i.test(intent.message) ? `I said hello to ${agent}.` : `I said that to ${agent}.`;
    }
    case "close":
      return speakForCloseSummary(summary);
    case "close_all":
      return "Closed everything.";
    case "focus": {
      const focused = summaryObject(summary);
      const ref = ctx.nodeRefs.find((node) => node.name === focused);
      const alias = ref?.aliases?.find((candidate) => /codex|claude|cursor|gemini|aider|opencode/i.test(candidate));
      const aliasLabel = alias && /agent$/i.test(alias) ? alias : alias ? `${alias} agent` : "";
      return aliasLabel ? `Focused ${focused}, the ${aliasLabel}.` : `Done — focused ${focused}.`;
    }
    case "arrange":
      return "Done — the canvas is tidied up.";
    case "create_node":
      return `Done — I created a ${intent.nodeType} node.`;
    case "open_browser":
      return intent.url ? `Opening a browser at ${intent.url}.` : "Opening a browser now.";
    case "navigate_browser":
      return intent.url ? `Done — navigating the browser there.` : "Done — browser navigation is queued.";
    case "snapshot_browser":
      return "Done — I grabbed the browser snapshot.";
    case "run_task":
      return intent.mode === "team" ? `Running ${intent.target} with the team.` : `Running ${intent.target} now.`;
    case "recover":
      return `Reconnecting ${intent.target}.`;
    case "make_lead":
      return `Done — ${intent.target} is the lead now.`;
    case "switch_project":
      return `${summary}.`;
    case "open_page":
      return intent.page === "settings" ? "Opening settings." : "Opening the canvas gallery.";
    case "new_project":
      return "Starting a new project — pick a folder.";
    default:
      return `Done — ${summary.toLowerCase()}.`;
  }
}

export function executeS2sCanvasToolCall(
  call: S2sToolCall,
  ctx: NlCommandContext,
  exec: NlEffectExecutor,
): S2sCanvasToolResult {
  const intents = parseToolIntents(call);
  if ("error" in intents) return { ok: false, error: intents.error, speak: "I can’t run that by voice yet." };
  if (intents.length !== 1) return executeBatchIntents(intents, ctx, exec);
  const intent = intents[0];

  const confidenceGate = mediumConfidenceClarify(intent, ctx);
  if (confidenceGate) return confidenceGate;

  if (intent.action === "close") return executeCloseIntent(intent, ctx, exec);

  const resolution = resolveNlIntent(intent, ctx);
  if ("error" in resolution) {
    if (resolution.clarify) {
      const clarify = clarifyResult(resolution.clarify);
      return { ok: false, error: resolution.error, speak: clarify.question, clarify };
    }
    return { ok: false, error: resolution.error, speak: "I couldn’t find that target." };
  }
  if (resolution.destructive && intent.action !== "close_all") {
    return {
      ok: false,
      error: `Realtime voice cannot run destructive action: ${resolution.summary}.`,
      speak: "That one needs confirmation in the command bar.",
    };
  }

  const outcome = executeNlEffect(resolution.effect, exec);
  if (outcome.command?.error) return { ok: false, error: outcome.command.error, speak: "That command failed." };
  if (outcome.appDelivered === false) {
    return { ok: false, error: `${resolution.summary} is not available here.`, speak: "That action isn’t available here." };
  }
  if (outcome.send && outcome.send.delivered.length === 0 && outcome.send.queued.length === 0) {
    return { ok: false, error: `${resolution.summary} — agent isn't running yet.`, speak: "That agent isn’t running yet." };
  }

  return {
    ok: true,
    summary: resolution.summary,
    speak: speakForSuccess(intent, resolution.summary, ctx),
    ...(outcome.command?.nodeId ? { nodeId: outcome.command.nodeId } : {}),
    ...(outcome.send?.queued.length ? { queued: true } : {}),
  };
}
