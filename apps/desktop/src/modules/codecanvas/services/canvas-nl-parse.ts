import type { CanvasCreateNodeKind } from "./commands/canvas-command";
import {
  INTENT_REGISTRY,
  MAX_NL_SPAWN_COUNT,
  intentByName,
  parseNlSpawnCount,
  type CanvasNodeRef,
  type IntentParamCtx,
  type NlCanvasIntent,
} from "./canvas-nl-command";

/**
 * NL Command Bar parsing: turn the user's natural-language request into a structured
 * {@link NlCanvasIntent} the resolver can execute. The intent schema lives in ONE place — the
 * Intent Registry (canvas-nl-command.ts) — so this prompt, the realtime (STS) tool defs, and the
 * validators never drift. `buildNlIntentPrompt` constrains the Bridge to emit one discriminated JSON
 * outcome (`intents | answer | error`); `parseNlIntents` robustly extracts it and hands intent
 * validation to the matching registry entry. (`parseNlIntent` keeps the legacy single-intent shape.) All are
 * pure — the actual model call lives in the runtime layer.
 */

export interface NlIntentPromptInput {
  text: string;
  /** Live agent person-names, so the model can resolve "Skye"/"Rex" targets. */
  agentNames: string[];
  /** Optional compact target hints for realtime tools, e.g. "Bima (Claude 3 / Cloud three)". */
  agentTargetHints?: string[];
  hasBrowserNodes?: boolean;
  hasPendingClarification?: boolean;
  /** Node kinds the bar can create. */
  nodeKinds: readonly CanvasCreateNodeKind[];
  /** All named nodes on the canvas — so the model can target tasks/terminals/browsers/notes by name. */
  nodeRefs?: CanvasNodeRef[];
  /** Currently selected nodes. Lets the model resolve "the browser" / "this browser" deterministically. */
  selectedNodeIds?: readonly string[];
  /** Open project names — surfaced in switch_project's target enum for grounded switching. */
  projectNames?: string[];
  /**
   * Pre-formatted recent-command lines (newest first), e.g. "buka 2 browser → opened Browser 2,
   * Browser 3". Serialized dialogue state so the planner can resolve anaphora ("close them", "yang
   * tadi") — see `canvas-nl-dialogue-state.ts`. Built by the caller to keep this module pure.
   */
  recentCommands?: readonly string[];
  /**
   * Pre-formatted lines describing diagrams already on the canvas (id-bearing), so a "draw_diagram"
   * request phrased as an edit ("add a step to the login flow") reuses the existing node ids and the
   * runtime replaces that diagram in place instead of drawing a duplicate. Built by the caller
   * (see `formatCurrentDiagrams`) to keep this module pure.
   */
  currentDiagrams?: readonly string[];
}

/** Cap on listed non-agent nodes, to keep the prompt bounded on large canvases. */
const MAX_LISTED_NODES = 40;

/**
 * Per-type node counts over ALL nodes (not the display-capped list), e.g. "3 browser, 1 terminal".
 * Grounds the planner so collective/quantifier requests ("close all browsers", "how many browsers?")
 * resolve against real counts even on a canvas larger than {@link MAX_LISTED_NODES}.
 */
function nodeCountsLine(nodeRefs: CanvasNodeRef[]): string | null {
  if (nodeRefs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of nodeRefs) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const parts = Array.from(counts.entries()).map(([kind, n]) => `${n} ${kind}`);
  return `Current canvas state — nodes by type: ${parts.join(", ")}.`;
}

export function buildNlIntentPrompt(input: NlIntentPromptInput): string {
  const agents = input.agentNames.length > 0 ? input.agentNames.join(", ") : "(none on canvas)";
  const ctx: IntentParamCtx = {
    nodeKinds: input.nodeKinds,
    agentNames: input.agentNames,
    agentTargetHints: input.agentTargetHints,
    hasBrowserNodes: input.hasBrowserNodes,
    hasPendingClarification: input.hasPendingClarification,
    projectNames: input.projectNames,
  };
  const schemaLines = INTENT_REGISTRY.map((def) => `- ${def.promptSchema(ctx)}`);
  const countsLine = nodeCountsLine(input.nodeRefs ?? []);

  // Non-agent nodes the model can name as focus/close/run_task/open_browser/recover targets.
  const otherNodes = (input.nodeRefs ?? [])
    .filter((r) => r.kind !== "agent")
    .slice(0, MAX_LISTED_NODES)
    .map((r) => {
      const aliases = (r.aliases ?? []).filter((alias) => alias && alias !== r.name);
      return `${r.name} (${r.kind}${aliases.length ? `; aliases: ${aliases.join(", ")}` : ""})`;
    });
  const targetLine =
    otherNodes.length > 0 ? `Other nodes you can target by name: ${otherNodes.join(", ")}.` : null;
  const selectedIds = new Set(input.selectedNodeIds ?? []);
  const selectedNodes = (input.nodeRefs ?? [])
    .filter((r) => selectedIds.has(r.id))
    .slice(0, MAX_LISTED_NODES)
    .map((r) => `${r.name} (${r.kind})`);
  const selectedLine = selectedNodes.length > 0 ? `Selected nodes: ${selectedNodes.join(", ")}.` : null;

  const diagrams = input.currentDiagrams ?? [];
  const diagramBlock =
    diagrams.length > 0
      ? ["Diagrams currently on the canvas (reuse a diagram's node ids in draw_diagram to EDIT it in place, adding/renaming nodes; use fresh ids only for a genuinely new diagram):", ...diagrams.map((line) => `- ${line}`)]
      : [];

  const recent = (input.recentCommands ?? []).slice(0, 5);
  const recentBlock =
    recent.length > 0
      ? [
          'Recent commands (newest first). Resolve anaphora like "them"/"it"/"yang tadi"/"those" against these — for a close, use target {"kind":"lastMentioned"}:',
          ...recent.map((line) => `- ${line}`),
        ]
      : [];

  return [
    "You translate a user's request into exactly one JSON outcome. Always return {\"outcome\":\"intents\"|\"answer\"|\"error\",\"intents\":<array or null>,\"answer\":<string or null>,\"error\":<string or null>}. Populate only the field matching outcome and set the other two to null. Reply with ONLY that JSON object — no prose or code fences.",
    "",
    "Intent schema (each array element picks exactly one action):",
    ...schemaLines,
    "",
    ...(countsLine ? [countsLine] : []),
    `Agents currently on the canvas: ${agents}.`,
    ...(targetLine ? [targetLine] : []),
    ...diagramBlock,
    ...recentBlock,
    ...(selectedLine ? [selectedLine, 'When the user says "the browser", "current browser", or "this browser", prefer the selected browser node if one is selected.'] : []),
    'A message or question addressed to one of those agents by name (e.g. "Rowan, what do you think?") is a dispatch to that agent — put the full message verbatim in "task". Never reject it as conversational.',
    'Be pragmatic with spawn_agent runners (this bar is voice-first, so names get mis-heard): if a spoken runner is an approximate match to a listed runner (e.g. "Weasley" → a "acme" runner), USE the closest listed runner. Treat generic phrases like "cloud agent"/"a cloud one" as claude. Prefer a best-guess spawn over an {"error"} asking to clarify — only error if there is genuinely no reasonable match.',
    'For an informational question about the visible canvas itself (e.g. "how many agents are here?", "what can you do?") that is NOT an action, choose outcome "answer" with one short grounded sentence in the same language as the user. Use only facts explicitly listed above.',
    'You cannot inspect or analyze repository files, source code, the codebase, or project architecture. For those requests choose outcome "error" with "Select a coding agent so it can inspect the repository."; never invent an answer or Canvas action.',
    'If the request does not map to any action or grounded visible-canvas answer, choose outcome "error" with a short reason in the same language as the user.',
    "",
    `User request: ${input.text}`,
  ].join("\n");
}

/**
 * Realtime (STS) tool definitions, generated from the SAME registry the prompt uses. A speech-to-
 * speech model calls these tools natively (no text planner in the loop); the resolver then runs the
 * returned intent exactly as the typed path does. Keeps voice additive — no second schema to maintain.
 */
export function buildRealtimeToolDefs(
  ctx: IntentParamCtx,
): Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }> {
  return INTENT_REGISTRY.map((def) => ({
    type: "function",
    name: def.name,
    description: def.description,
    parameters: def.toolParams(ctx),
  }));
}

/**
 * JSON Schema for the parser's output, derived from the SAME registry as the prompt and STS tool defs.
 * Shape: one strict root object with an `outcome` discriminator plus required nullable
 * `intents`/`answer`/`error` payloads. A single root object remains compatible with strict structured
 * output while allowing grounded answers and honest errors instead of forcing every request into an
 * action. Each intent variant pins its `action` via `const`
 * and sets `additionalProperties:false`, per the structured-outputs requirements. Kept pure + registry-
 * driven so it never drifts from the executable contract. (Slice 7 — the live BYOK wiring that consumes
 * this is gated on an app rebuild + real-key verification; the schema itself is contract-tested here.)
 */
export function buildNlIntentJsonSchema(ctx: IntentParamCtx): Record<string, unknown> {
  const variants = INTENT_REGISTRY.map((def) => {
    const params = def.toolParams(ctx) as { properties?: Record<string, unknown>; required?: string[] };
    return {
      type: "object",
      properties: { action: { const: def.name }, ...(params.properties ?? {}) },
      required: ["action", ...(params.required ?? [])],
      additionalProperties: false,
    };
  });
  return {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["intents", "answer", "error"] },
      intents: {
        anyOf: [
          { type: "array", minItems: 1, items: { anyOf: variants } },
          { type: "null" },
        ],
      },
      answer: { type: ["string", "null"] },
      error: { type: ["string", "null"] },
    },
    required: ["outcome", "intents", "answer", "error"],
    additionalProperties: false,
  };
}

/**
 * The structured-output schema for the parser, built from the SAME {@link NlIntentPromptInput} as
 * {@link buildNlIntentPrompt} — so prompt and grammar always agree without the runner re-deriving the
 * intent context. Hand this to the transport's HTTP leg to grammar-enforce valid intent JSON.
 */
export function buildNlIntentSchema(input: NlIntentPromptInput): Record<string, unknown> {
  const ctx: IntentParamCtx = {
    nodeKinds: input.nodeKinds,
    agentNames: input.agentNames,
    agentTargetHints: input.agentTargetHints,
    hasBrowserNodes: input.hasBrowserNodes,
    hasPendingClarification: input.hasPendingClarification,
    projectNames: input.projectNames,
  };
  return buildNlIntentJsonSchema(ctx);
}

/**
 * Extract the first balanced top-level JSON value — object `{…}` or array `[…]` — from a model reply
 * (handles fences + prose). Only the chosen container's brackets count toward depth, so nested values
 * (objects inside an array, arrays inside an object) are spanned correctly.
 */
function extractJson(raw: string): string | null {
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{" || raw[i] === "[") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const PARSE_FAILURE = "Could not understand that — try rephrasing.";

/** Validates one parsed JSON object into a typed intent via the matching registry entry. */
function parseIntentObject(obj: Record<string, unknown>): NlCanvasIntent | { error: string } {
  const explicitError = str(obj.error);
  if (explicitError) return { error: explicitError };

  const action = typeof obj.action === "string" ? obj.action : "";
  const def = intentByName.get(action);
  if (!def) return { error: "That request isn't supported by the command bar yet." };
  return def.parse(obj);
}

/** Validates a list of raw objects into intents; fails the whole batch on the first bad element. */
function parseIntentList(list: unknown[]): NlCanvasIntent[] | { error: string } {
  if (list.length === 0) return { error: PARSE_FAILURE };
  const intents: NlCanvasIntent[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: PARSE_FAILURE };
    const raw = item as Record<string, unknown>;
    const one = parseIntentObject(raw);
    if ("error" in one) return one;
    const count = one.action === "spawn_agent" ? parseNlSpawnCount(raw.count) : 1;
    if (typeof count === "object") return count;
    if (intents.length + count > MAX_NL_SPAWN_COUNT) {
      return { error: `I can open up to ${MAX_NL_SPAWN_COUNT} agents at once.` };
    }
    for (let copy = 0; copy < count; copy++) intents.push({ ...one });
  }
  return intents;
}

/**
 * Parses + validates the strict discriminated outcome, while retaining legacy array/single-object
 * compatibility for CLI fallbacks and older tests. Conflicting discriminator/payload combinations fail
 * closed; an explicit error passes through and a grounded answer never becomes an executable intent.
 */
export function parseNlIntents(raw: string): NlCanvasIntent[] | { error: string } | { answer: string } {
  const json = extractJson(raw);
  if (!json) return { error: PARSE_FAILURE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: PARSE_FAILURE };
  }

  if (Array.isArray(parsed)) return parseIntentList(parsed);

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.outcome === "string") {
      const hasIntents = Array.isArray(obj.intents) && obj.intents.length > 0;
      const hasAnswer = !!str(obj.answer);
      const hasError = !!str(obj.error);
      const valid =
        (obj.outcome === "intents" && hasIntents && !hasAnswer && !hasError)
        || (obj.outcome === "answer" && !hasIntents && hasAnswer && !hasError)
        || (obj.outcome === "error" && !hasIntents && !hasAnswer && hasError);
      if (!valid) return { error: PARSE_FAILURE };
    }
    const explicitError = str(obj.error);
    if (explicitError) return { error: explicitError };
    // Conversational/informational reply (not a canvas action) — surfaced + spoken, not an error.
    const answer = str(obj.answer);
    if (answer) return { answer };
    if (Array.isArray(obj.intents)) return parseIntentList(obj.intents);
    return parseIntentList([obj]);
  }

  return { error: PARSE_FAILURE };
}

/**
 * Single-intent convenience: parses a model reply expected to hold exactly one intent object.
 * Retained for callers/tests that want the scalar shape; the bar uses {@link parseNlIntents}.
 */
export function parseNlIntent(raw: string): NlCanvasIntent | { error: string } {
  const json = extractJson(raw);
  if (!json) return { error: PARSE_FAILURE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: PARSE_FAILURE };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: PARSE_FAILURE };
  return parseIntentObject(parsed as Record<string, unknown>);
}
