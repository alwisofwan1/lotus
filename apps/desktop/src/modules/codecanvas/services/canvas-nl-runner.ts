import type { CanvasCommand, CanvasCommandResult, CanvasCreateNodeKind } from "./commands/canvas-command";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import type { SendResult } from "./canvas-agent-messaging";
import { buildNlIntentPrompt, buildNlIntentSchema, parseNlIntents } from "./canvas-nl-parse";
import { batchNodeIndex, isBatchNodeId, resolveNlIntents, type AppCommand, type CanvasNodeRef, type CanvasProjectRef, type NlCanvasIntent, type NlClarifyError, type NlEffect, type NlResolution } from "./canvas-nl-command";
import { matchLocalIntent } from "./canvas-nl-fastpath";
import { lastMentionedIds, type NlDialogueState } from "./canvas-nl-dialogue-state";
import { isRepositoryWorkRequest } from "./repository-work-request";

export interface NlRunnerDeps {
  /** Calls the Bridge/model with the intent prompt and resolves with its final text reply. `schema`
   *  (optional) grammar-enforces the reply when the transport's HTTP leg supports structured output;
   *  a caller that ignores it (CLI fallback, tests) still gets correct free-form parsing. */
  callModel: (prompt: string, schema?: Record<string, unknown>) => Promise<string>;
  /** Live agent roster — the pool for dispatch (running sessions). */
  roster: AgentStatusSnapshot[];
  /** Every canvas node indexed by name — the pool for focus/close (any node). */
  nodeRefs: CanvasNodeRef[];
  /** Currently-selected node ids, used for commands like "navigate the browser". */
  selectedNodeIds?: readonly string[];
  /** Node kinds the command bar may create. */
  nodeKinds: readonly CanvasCreateNodeKind[];
  /** Locale-resolved auto-name roster for spawned agents (voice-friendly handles). */
  namePool?: readonly string[];
  /** Open canvas projects — the pool for "switch to project X" / "close project X". */
  projects?: CanvasProjectRef[];
  /** Id of the active project, so "close this project" targets the current one. */
  activeProjectId?: string;
  /** Id of the previous project (most-recently-opened other than active), for "go back" / "proyek tadi". */
  previousProjectId?: string;
  /**
   * Short-term dialogue state (last few turns). Used to (a) resolve anaphoric targets like "close
   * them"/"tutup yang tadi" to the nodes a prior turn touched, and (b) ground the planner prompt with
   * recent commands. Owned by the command bar; see `canvas-nl-dialogue-state.ts`.
   */
  dialogueState?: NlDialogueState;
  /** Pre-formatted current-diagram lines (see `formatCurrentDiagrams`) so an edit request reuses ids. */
  currentDiagrams?: readonly string[];
}

/** One recent-command line for the planner prompt, e.g. "buka 2 browser → open_browser, open_browser". */
function formatRecentCommands(state: NlDialogueState | undefined): string[] {
  return (state?.recent ?? []).map((t) => `${t.utterance} → ${t.actions.join(", ")}${t.outcome === "error" ? " (failed)" : ""}`);
}

/**
 * Opt-in per machine: `localStorage.setItem("lotus.debug.nlFastpathMisses", "1")`.
 *
 * Knowing the exact phrasing of a fast-path miss is how misses get folded into the 0-token path, but
 * the utterance is user content — and one that is about to be sent to a BYOK provider. Logging it by
 * default left a second copy in the devtools console that nobody asked for, so the default now records
 * only that a miss happened (and its shape), which is enough to spot a regression in the miss rate.
 */
const FASTPATH_MISS_LOG_KEY = "lotus.debug.nlFastpathMisses";

function logFastpathMiss(text: string): void {
  let verbose = false;
  try {
    verbose = typeof window !== "undefined" && window.localStorage?.getItem(FASTPATH_MISS_LOG_KEY) === "1";
  } catch {
    /* storage blocked (private mode) — stay on the quiet path */
  }
  if (verbose) {
    console.info(`[nl-fastpath] miss → ${JSON.stringify(text)}`);
    return;
  }
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  console.info(`[nl-fastpath] miss (${words}w, ${text.length}c) — set localStorage["${FASTPATH_MISS_LOG_KEY}"]="1" to log the phrasing`);
}

/**
 * The NL Command Bar pipeline (Fase 1): build the intent prompt, ask the model, parse its reply into
 * one or more intents, and resolve them to executable effects. The model call is injected
 * (`callModel`) so the whole flow is unit-testable; the runtime wires it to the canvas agent runner.
 * Returns the resolutions in execution order, or — on any failure (model error, unparseable reply,
 * unresolvable name) — `{ error }`. A single-action request resolves to a 1-element array.
 */
export async function runNlCommand(
  text: string,
  deps: NlRunnerDeps,
): Promise<NlResolution[] | NlClarifyError | { answer: string }> {
  // Fast path: resolve common single commands locally (0 tokens, no round-trip). Only the ambiguous /
  // compound / content-bearing requests fall through to the haiku planner below.
  // Referents for anaphora ("close them"): prior-turn node ids that still exist on the canvas.
  const aliveIds = new Set(deps.nodeRefs.map((r) => r.id));
  const lastMentioned = deps.dialogueState ? lastMentionedIds(deps.dialogueState, aliveIds) : undefined;
  const resolveCtx = {
    roster: deps.roster,
    nodeRefs: deps.nodeRefs,
    selectedNodeIds: deps.selectedNodeIds,
    lastMentionedIds: lastMentioned,
    namePool: deps.namePool,
    projects: deps.projects,
    activeProjectId: deps.activeProjectId,
    previousProjectId: deps.previousProjectId,
  };

  const local = matchLocalIntent(text, {
    nodeKinds: deps.nodeKinds,
    agentNames: deps.roster.map((a) => a.name),
    frameNames: deps.nodeRefs.filter((r) => r.kind === "frame").map((r) => r.name),
  });
  if (local) return resolveNlIntents(local, resolveCtx);

  // This utility planner has no filesystem tools or repository content. Refuse untargeted requests
  // locally; explicit `tell/ask <agent>` already resolved above to the coding-agent dispatch path.
  if (isRepositoryWorkRequest(text)) {
    return { error: "Select a coding agent so it can inspect the repository." };
  }

  // Fast-path MISS: this utterance now needs a BYOK round-trip. Recorded so a rising miss rate is
  // visible; the phrasing itself is behind an opt-in flag (see logFastpathMiss).
  logFastpathMiss(text);

  const promptInput = {
    text,
    agentNames: deps.roster.map((a) => a.name),
    nodeKinds: deps.nodeKinds,
    nodeRefs: deps.nodeRefs,
    selectedNodeIds: deps.selectedNodeIds,
    projectNames: deps.projects?.map((p) => p.name),
    recentCommands: formatRecentCommands(deps.dialogueState),
    currentDiagrams: deps.currentDiagrams,
  };
  const prompt = buildNlIntentPrompt(promptInput);
  // Grammar-enforce the reply from the SAME registry as the prompt (structured output) so a malformed
  // JSON reply can't reach parseNlIntents. Free-form legs (CLI fallback) ignore it and stay correct.
  const schema = buildNlIntentSchema(promptInput);

  let raw: string;
  try {
    raw = await deps.callModel(prompt, schema);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const parsed = parseNlIntents(raw);
  if ("error" in parsed) return parsed;
  if ("answer" in parsed) return parsed; // conversational reply — surfaced + spoken, no effect
  return resolveNlIntents(parsed, resolveCtx);
}

/**
 * Re-resolve the pending intents after the user disambiguates a clarification (Option C, ADR-0034).
 * Filtering the non-chosen candidates out of the node/agent pools makes the ambiguous name resolve
 * uniquely to `chosenId` — no override plumbing in the resolvers. Reuses `resolveNlIntents`.
 */
export function resolveClarifiedIntents(
  intents: NlCanvasIntent[],
  deps: Pick<NlRunnerDeps, "roster" | "nodeRefs" | "selectedNodeIds" | "namePool" | "dialogueState" | "projects" | "activeProjectId" | "previousProjectId">,
  choice: { chosenId: string; candidateIds: readonly string[] },
): NlResolution[] | NlClarifyError {
  const drop = new Set(choice.candidateIds.filter((id) => id !== choice.chosenId));
  const nodeRefs = deps.nodeRefs.filter((r) => !drop.has(r.id));
  const roster = deps.roster.filter((a) => !drop.has(a.id));
  // A project clarification narrows the project pool the same way node/agent clarifications narrow theirs.
  const projects = deps.projects?.filter((p) => !drop.has(p.id));
  const aliveIds = new Set(nodeRefs.map((r) => r.id));
  const lastMentioned = deps.dialogueState ? lastMentionedIds(deps.dialogueState, aliveIds) : undefined;
  return resolveNlIntents(intents, {
    roster,
    nodeRefs,
    selectedNodeIds: deps.selectedNodeIds,
    lastMentionedIds: lastMentioned,
    namePool: deps.namePool,
    projects,
    activeProjectId: deps.activeProjectId,
    previousProjectId: deps.previousProjectId,
  });
}

export interface NlEffectExecutor {
  /** Runs a canvas command (e.g. create/focus/close) through the command center, returning its result
   *  ({ nodeId }) so the batch executor can record the real id of a just-created node. */
  runCommand: (command: CanvasCommand) => CanvasCommandResult | void;
  /** Dispatches a task/message to a live agent (e.g. via sendAgentMessage). Returns the delivery
   *  outcome so the caller can tell the user when a target had no live session to receive it. */
  dispatch: (agentId: string, text: string) => SendResult;
  /** Runs an app-level command (switch project, open a page, new/close project) via the host's docked
   *  navigation callbacks. Returns whether it was actually delivered — `false` when the host has no
   *  docked navigation (e.g. detached command bar), so the batch reports the no-op instead of a false
   *  "done" (app intents resolve fine but can't run without a docked host). */
  runApp: (command: AppCommand) => boolean;
}

/** Outcome of one effect: the command result (for create id capture), the dispatch send result, or
 *  whether an app-level navigation was actually carried out. */
export interface NlEffectOutcome {
  command?: CanvasCommandResult;
  send?: SendResult;
  /** For an app effect: true if the host performed the navigation, false if it was a no-op. */
  appDelivered?: boolean;
}

/**
 * Routes a resolved NL effect to the right side-effect. Destructive effects must be confirmed first.
 * Returns the command result (so the batch can capture a created node's id), the dispatch result, or
 * the app delivery flag.
 */
export function executeNlEffect(effect: NlEffect, exec: NlEffectExecutor): NlEffectOutcome {
  if (effect.kind === "command") {
    return { command: exec.runCommand(effect.command) ?? undefined };
  }
  if (effect.kind === "app") {
    return { appDelivered: exec.runApp(effect.command) };
  }
  return { send: exec.dispatch(effect.agentId, effect.text) };
}

/**
 * Rebind any {@link batchNodeId} placeholder in a command effect to the real node id created earlier
 * in the same batch. Returns the bound effect, or `null` when the referenced create hasn't produced a
 * real id (e.g. the create failed) so the executor can skip the dependent step instead of targeting a
 * ghost. Non-command effects and effects without a batch placeholder pass through unchanged.
 */
export function bindBatchNodeIds(effect: NlEffect, realIds: (string | undefined)[]): NlEffect | null {
  if (effect.kind !== "command") return effect;
  const command = effect.command;
  if (!("nodeId" in command) || typeof command.nodeId !== "string" || !isBatchNodeId(command.nodeId)) {
    return effect;
  }
  const index = batchNodeIndex(command.nodeId);
  const real = index === null ? undefined : realIds[index];
  if (!real) return null;
  return { kind: "command", command: { ...command, nodeId: real } };
}
