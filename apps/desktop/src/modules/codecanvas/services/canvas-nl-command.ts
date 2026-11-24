import { CANVAS_CREATE_NODE_KINDS, type CanvasCommand, type CanvasCreateNodeKind } from "./commands/canvas-command";
import { buildAgentRunnerAliases } from "./canvas-agent-aliases";
import type { DiagramGraph, DiagramNode, DiagramEdge } from "./agent-draw/diagram-layout";
import { normalizeNameQuery, foldForMatch } from "./canvas-name-match";
import { levenshtein } from "./runner-fuzzy";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import { buildSpawnFirstAgentDefinition } from "./spawn-first-agent";
import { fuzzyMatchName, resolveRunnerAlias } from "./runner-fuzzy";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { TaskDispatchMode } from "../types/canvas";
import { normalizeBrowserUrl } from "./browser-url";
import { browserDisplayName, browserDefaultName, browserHost } from "./browser-node-identity";
import { terminalAliases, terminalDisplayName } from "./terminal/terminal-node-identity";
import { frameIntentDefs } from "./canvas-nl-frames";

/**
 * NL Command Bar core (Fase 1). Pure intent → effect resolution for the canvas command bar:
 * the Bridge parses natural language into a structured {@link NlCanvasIntent}; this maps it to an
 * effect the bar executes (a canvas command via the command center, or a dispatch to a live agent
 * via sendAgentMessage), classifies destructive actions for confirmation, and resolves agent
 * person-names to ids. Scope is Tier 1 (canvas manipulation) + Tier 1.5 (single-agent dispatch);
 * multi-step orchestration stays the Director's job (ADR-0022 / PLAN Fase 1).
 */

export type AgentNameResolution =
  | { ok: true; id: string }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; candidates: { id: string; name: string }[] };

/**
 * Resolves a person-style agent name to its node id (the cross-agent coordination handle).
 * Case-insensitive; never guesses — duplicate display names report `ambiguous` so the bar can ask.
 * Scoped to the LIVE roster (not all agent nodes) because dispatch targets a running session.
 */
function agentNames(agent: AgentStatusSnapshot): string[] {
  return [agent.name, ...(agent.aliases ?? [])].filter(Boolean);
}

function uniqueAgents(agents: AgentStatusSnapshot[]): AgentStatusSnapshot[] {
  const byId = new Map<string, AgentStatusSnapshot>();
  for (const agent of agents) {
    if (!byId.has(agent.id)) byId.set(agent.id, agent);
  }
  return Array.from(byId.values());
}

function ambiguousAgents(matches: AgentStatusSnapshot[]): AgentNameResolution {
  return { ok: false, reason: "ambiguous", candidates: matches.map((agent) => ({ id: agent.id, name: agent.name })) };
}

export function resolveAgentByName(name: string, roster: AgentStatusSnapshot[]): AgentNameResolution {
  const query = normalizeNameQuery(name);
  if (!query) return { ok: false, reason: "not-found" };

  const exact = uniqueAgents(roster.filter((agent) => agentNames(agent).some((candidate) => normalizeNameQuery(candidate) === query)));
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  if (exact.length > 1) return ambiguousAgents(exact);

  const partial = uniqueAgents(roster.filter((agent) => agentNames(agent).some((candidate) => normalizeNameQuery(candidate).includes(query))));
  if (partial.length === 1) return { ok: true, id: partial[0].id };
  if (partial.length > 1) return ambiguousAgents(partial);

  const foldedQuery = foldForMatch(name);
  const folded = uniqueAgents(roster.filter((agent) => agentNames(agent).some((candidate) => foldForMatch(candidate) === foldedQuery)));
  if (folded.length === 1) return { ok: true, id: folded[0].id };
  if (folded.length > 1) return ambiguousAgents(folded);

  const threshold = Math.min(2, Math.floor(foldedQuery.length / 4));
  if (threshold >= 1) {
    const scored = uniqueAgents(roster)
      .map((agent) => ({ agent, dist: Math.min(...agentNames(agent).map((candidate) => levenshtein(foldForMatch(candidate), foldedQuery))) }))
      .filter((score) => score.dist <= threshold)
      .sort((a, b) => a.dist - b.dist);
    if (scored.length === 1) return { ok: true, id: scored[0].agent.id };
    if (scored.length > 1) {
      if (scored[1].dist - scored[0].dist >= 1) return { ok: true, id: scored[0].agent.id };
      return ambiguousAgents(scored.map((score) => score.agent));
    }
  }

  return { ok: false, reason: "not-found" };
}

/** A lightweight handle on any canvas node, for resolving NL targets by human name. */
export interface CanvasNodeRef {
  id: string;
  /** The ReactFlow node type ("agent" | "task" | "terminal" | "note" | "browser" | …). */
  kind: string;
  /** Human-facing name used for matching (agent name, task title, note's first line, …). */
  name: string;
  /** Secondary human handles for the same node, e.g. "Browser 1" and the current host. */
  aliases?: string[];
  /** The Frame this node belongs to, when it is in one (Frames, LOT2-129). */
  frameId?: string;
}

export type NodeNameResolution =
  | { ok: true; id: string; ref: CanvasNodeRef }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; candidates: CanvasNodeRef[] };

/** A lightweight handle on an open canvas project, for resolving switch/close targets by human name. */
export interface CanvasProjectRef {
  id: string;
  /** Display name — the project alias, or the basename of its root directory. */
  name: string;
  /** Secondary handles (e.g. the folder basename when an alias is set, or a shortened form). */
  aliases?: string[];
}

/**
 * Resolves a spoken/typed project name to a single open project. Reuses {@link resolveNodeByName}'s
 * four-tier matcher (exact → substring → fold-exact → conservative fuzzy) by viewing each project as a
 * node ref, so project switching inherits the same transcription tolerance as node targeting.
 */
export function resolveProjectByName(name: string, projects: CanvasProjectRef[]): NodeNameResolution {
  const refs: CanvasNodeRef[] = projects.map((p) => ({
    id: p.id,
    kind: "project",
    name: p.name,
    ...(p.aliases && p.aliases.length ? { aliases: p.aliases } : {}),
  }));
  return resolveNodeByName(name, refs);
}

/** The human name a node is addressed by. Defensive — runtime node data is loosely typed. */
function nodeDisplayName(kind: string, data: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  switch (kind) {
    case "agent":
    case "team":
      return s(data.name);
    case "task":
    case "plan":
    case "context":
    case "critic":
    case "human-gate":
      return s(data.title);
    case "note":
      return s(data.content).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
    case "terminal":
      return terminalDisplayName({ label: data.label, terminalNumber: data.terminalNumber });
    case "browser":
      return browserDisplayName({
        browserNumber: typeof data.browserNumber === "number" ? data.browserNumber : undefined,
        label: s(data.label),
        pageTitle: s(data.pageTitle),
        url: s(data.url),
      });
    case "music":
      // Fixed handle so "close the music player" / "focus player" resolve by name.
      return "Music Player";
    default:
      return s(data.title) || s(data.name);
  }
}

/** Builds the name index the resolver matches against. Nodes without a usable name are skipped. */
export function buildNodeIndex(nodes: Array<{ id: string; type?: string; data?: unknown }>): CanvasNodeRef[] {
  const refs: CanvasNodeRef[] = [];
  const runnerSeen = new Map<string, number>();
  for (const node of nodes) {
    if (!node.type) continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const name = nodeDisplayName(node.type, data);
    if (!name) continue;
    if (node.type === "agent") {
      const runner = typeof data.runner === "string" ? data.runner.trim().toLowerCase() : "";
      const ordinal = runner ? (runnerSeen.get(runner) ?? 0) + 1 : undefined;
      if (runner && ordinal) runnerSeen.set(runner, ordinal);
      const aliases = buildAgentRunnerAliases({
        name,
        runner: data.runner,
        runnerLabel: data.runnerLabel ?? data.runnerName,
        runnerCommand: data.runnerCommand,
        runnerOrdinal: ordinal,
      });
      refs.push({ id: node.id, kind: node.type, name, ...(aliases.length ? { aliases } : {}) });
    } else if (node.type === "terminal") {
      const aliases = terminalAliases({ label: data.label, terminalNumber: data.terminalNumber });
      refs.push({ id: node.id, kind: node.type, name, ...(aliases.length ? { aliases } : {}) });
    } else if (node.type === "browser") {
      const browserNumber = typeof data.browserNumber === "number" ? data.browserNumber : undefined;
      const fallbackName = browserDefaultName(browserNumber);
      const host = browserHost(typeof data.url === "string" ? data.url : "");
      const aliases = Array.from(new Set([fallbackName, host].filter((alias) => alias && alias !== name)));
      refs.push({ id: node.id, kind: node.type, name, ...(aliases.length ? { aliases } : {}) });
    } else {
      refs.push({ id: node.id, kind: node.type, name });
    }
  }
  // Frame membership, so "take T2 out of frame Auth" can check T2 is in Auth.
  const frameOf = new Map<string, string>();
  for (const node of nodes) {
    const fid = (node.data as { frameId?: unknown } | undefined)?.frameId;
    if (typeof fid === "string" && fid) frameOf.set(node.id, fid);
  }
  return frameOf.size === 0 ? refs : refs.map((r) => (frameOf.has(r.id) ? { ...r, frameId: frameOf.get(r.id) } : r));
}

function refNames(ref: CanvasNodeRef): string[] {
  return [ref.name, ...(ref.aliases ?? [])].filter(Boolean);
}

function uniqueRefs(refs: CanvasNodeRef[]): CanvasNodeRef[] {
  const byId = new Map<string, CanvasNodeRef>();
  for (const ref of refs) {
    if (!byId.has(ref.id)) byId.set(ref.id, ref);
  }
  return Array.from(byId.values());
}

/**
 * Resolves a human name to a single node id. Exact (case-insensitive) wins; if none, falls back to a
 * unique substring match so "the auth task" finds "Fix auth bug". Never guesses — multiple matches at
 * either tier report `ambiguous` so the bar can ask. `opts.kind` constrains the search to node kinds.
 */
export function resolveNodeByName(
  name: string,
  refs: CanvasNodeRef[],
  opts?: { kind?: string | readonly string[] },
): NodeNameResolution {
  const query = normalizeNameQuery(name);
  if (!query) return { ok: false, reason: "not-found" };
  const kinds = opts?.kind ? (Array.isArray(opts.kind) ? opts.kind : [opts.kind]) : null;
  const pool = kinds ? refs.filter((r) => kinds.includes(r.kind)) : refs;

  const exact = uniqueRefs(pool.filter((r) => refNames(r).some((name) => normalizeNameQuery(name) === query)));
  if (exact.length === 1) return { ok: true, id: exact[0].id, ref: exact[0] };
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact };

  const partial = uniqueRefs(pool.filter((r) => refNames(r).some((name) => normalizeNameQuery(name).includes(query))));
  if (partial.length === 1) return { ok: true, id: partial[0].id, ref: partial[0] };
  if (partial.length > 1) return { ok: false, reason: "ambiguous", candidates: partial };

  // Tier 3 — fold-exact: tolerate spoken-number slips ("Browser two"/"browser too" → "Browser 2").
  const fq = foldForMatch(name);
  const folded = uniqueRefs(pool.filter((r) => refNames(r).some((n) => foldForMatch(n) === fq)));
  if (folded.length === 1) return { ok: true, id: folded[0].id, ref: folded[0] };
  if (folded.length > 1) return { ok: false, reason: "ambiguous", candidates: folded };

  // Tier 4 — conservative fuzzy: recover a 1–2 char transcription slip, ambiguity-aware. The threshold
  // scales with query length (short queries demand near-exact) so an unrelated word never matches, and
  // two candidates that tie (or nearly tie) report `ambiguous` rather than guessing.
  const threshold = Math.min(2, Math.floor(fq.length / 4));
  if (threshold >= 1) {
    const scored = uniqueRefs(pool)
      .map((r) => ({ ref: r, dist: Math.min(...refNames(r).map((n) => levenshtein(foldForMatch(n), fq))) }))
      .filter((s) => s.dist <= threshold)
      .sort((a, b) => a.dist - b.dist);
    if (scored.length === 1) return { ok: true, id: scored[0].ref.id, ref: scored[0].ref };
    if (scored.length > 1) {
      if (scored[1].dist - scored[0].dist >= 1) return { ok: true, id: scored[0].ref.id, ref: scored[0].ref };
      return { ok: false, reason: "ambiguous", candidates: scored.map((s) => s.ref) };
    }
  }

  return { ok: false, reason: "not-found" };
}

/**
 * How an intent names the node(s) it acts on. A plain string is the legacy form (equivalent to
 * `{kind:"byName"}`) and stays accepted everywhere for back-compat; the discriminated union lets the
 * planner express *collectives* — "close all browsers" ({@link byType}, quantifier "all"), "close 2
 * browsers" (quantifier "count"), "close these" ({@link selection}), or "close them" (`lastMentioned`,
 * resolved from short-term dialogue state — see Slice 4). Returning a FILTER instead of a raw string is
 * what fixes "close semua browser" being read as a node literally named "semua browser".
 */
export type NlTarget =
  | { kind: "byName"; name: string }
  | { kind: "byType"; nodeType: string; quantifier: "all" | "count"; count?: number }
  | { kind: "selection" }
  | { kind: "lastMentioned" };

/** Coerce the legacy string target to the union form. Object targets pass through unchanged. */
export function normalizeNlTarget(target: string | NlTarget): NlTarget {
  return typeof target === "string" ? { kind: "byName", name: target } : target;
}

/** True for a target that resolves to a *set* of nodes (fanned out), not a single named node. */
export function isCollectiveTarget(target: string | NlTarget): boolean {
  return normalizeNlTarget(target).kind !== "byName";
}

/** Human noun for a node kind, used in collective error messages and grouped feedback. */
function kindNoun(kind: string): string {
  return kind === "human-gate" ? "human gate" : kind;
}

export type NodesResolution = { ok: true; refs: CanvasNodeRef[] } | { ok: false; error: string };

/**
 * Resolves a {@link NlTarget} to the set of nodes it selects. `byName` returns the single matched node
 * (or a name error). The collective kinds return every matching node so the caller can fan out one
 * effect per node: `byType` filters by node kind (quantifier "all" = all of that kind, "count" = the
 * first N), `selection` is the current selection, `lastMentioned` is wired in Slice 4. Empty results
 * are an actionable error, never a silent no-op.
 */
export function resolveNodesByTarget(target: NlTarget, ctx: NlCommandContext): NodesResolution {
  switch (target.kind) {
    case "byName": {
      const r = resolveNodeByName(target.name, ctx.nodeRefs);
      return r.ok ? { ok: true, refs: [r.ref] } : { ok: false, error: nameError(target.name, r.reason).error };
    }
    case "byType": {
      const pool = uniqueRefs(ctx.nodeRefs.filter((ref) => ref.kind === target.nodeType));
      if (pool.length === 0) return { ok: false, error: `No ${kindNoun(target.nodeType)} nodes on the canvas.` };
      if (target.quantifier === "count") {
        const n = target.count ?? 1;
        return { ok: true, refs: pool.slice(0, Math.max(1, n)) };
      }
      return { ok: true, refs: pool };
    }
    case "selection": {
      const selected = new Set(ctx.selectedNodeIds ?? []);
      const refs = uniqueRefs(ctx.nodeRefs.filter((ref) => selected.has(ref.id)));
      if (refs.length === 0) return { ok: false, error: "Nothing is selected." };
      return { ok: true, refs };
    }
    case "lastMentioned": {
      const ids = new Set(ctx.lastMentionedIds ?? []);
      const refs = uniqueRefs(ctx.nodeRefs.filter((ref) => ids.has(ref.id)));
      if (refs.length === 0) return { ok: false, error: "Nothing recent to refer to." };
      // Preserve the order the ids were mentioned in, not node-index order.
      const order = new Map((ctx.lastMentionedIds ?? []).map((id, i) => [id, i]));
      refs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return { ok: true, refs };
    }
  }
}

/** The structured intent the NL planner emits (Tier 1 + 1.5). */
export type NlCanvasIntent =
  | { action: "create_node"; nodeType: CanvasCreateNodeKind; content?: string }
  | { action: "arrange" }
  | { action: "focus"; target: string }
  | { action: "dispatch"; target: string; task: string }
  | { action: "say_to_agent"; target: string; message: string }
  | { action: "close"; target: string | NlTarget }
  | { action: "close_all" }
  | { action: "spawn_agent"; runner: AgentRunnerType; brief?: string; model?: string; runnerCommand?: string; runnerLabel?: string }
  | { action: "run_task"; target: string; mode: TaskDispatchMode }
  | { action: "open_browser"; url?: string; target?: string }
  | { action: "navigate_browser"; url: string; target?: string }
  | { action: "snapshot_browser"; target?: string }
  | { action: "recover"; target: string }
  | { action: "make_lead"; target: string }
  | { action: "switch_project"; target: string }
  | { action: "open_page"; page: AppPage }
  | { action: "new_project" }
  | { action: "close_project"; target?: string }
  | { action: "create_frame"; title?: string; members: string[] }
  | { action: "move_to_frame"; targets: string[]; frame?: string; frameIndex?: number }
  | { action: "leave_frame"; targets: string[]; frame?: string; frameIndex?: number }
  | { action: "go_to_frame"; frame?: string; frameIndex?: number }
  | { action: "draw_diagram"; topic: string; graph: DiagramGraph; diagramType?: string; direction?: "TB" | "LR" };

/** An app-level page the command bar can navigate to (not a canvas node). */
export type AppPage = "settings" | "canvases";

/**
 * An APP-level effect — switching the active project or navigating a page. Distinct from a
 * {@link CanvasCommand} (which mutates the current canvas): these change *which* canvas/page is in
 * view. Executed by the command bar's app executor, which maps each to the host's docked callbacks.
 */
export type AppCommand =
  | { type: "switch-project"; projectId: string }
  | { type: "open-page"; page: AppPage }
  | { type: "new-project" }
  | { type: "close-project"; projectId?: string };

/** What the bar actually executes: a command-center command, a dispatch to a live agent, or an
 *  app-level navigation (switch project / open a page). */
export type NlEffect =
  | { kind: "command"; command: CanvasCommand }
  | { kind: "dispatch"; agentId: string; text: string }
  | { kind: "app"; command: AppCommand };

/**
 * Language-neutral descriptor of what a resolution will do, for the SPOKEN channel only. `speak`
 * (below) is the canonical English phrasing; this lets the voice layer render a natural, native
 * confirmation in the user's language (id/ja) without the registry carrying per-language strings —
 * see `services/voice/localize-confirmation.ts`. Kept structured (not a string) so grouping and
 * grammar are the localizer's job, one place, per language.
 */
export type SpokenAction =
  | { kind: "spawn"; runner: string } // runner = display label, e.g. "Claude" / "Codex" / a custom name
  | { kind: "create"; nodeType: string }
  | { kind: "arrange" }
  | { kind: "focus"; target: string }
  | { kind: "dispatch"; target: string }
  | { kind: "say_to_agent"; target: string }
  | { kind: "close"; target: string }
  | { kind: "close_all" }
  | { kind: "run_task"; target: string; team: boolean }
  | { kind: "open_browser"; target?: string }
  | { kind: "navigate_browser"; target: string; url: string }
  | { kind: "recover"; target: string }
  | { kind: "make_lead"; target: string }
  | { kind: "switch_project"; target: string }
  | { kind: "open_page"; page: AppPage }
  | { kind: "new_project" }
  | { kind: "close_project"; target?: string };

export interface NlResolution {
  effect: NlEffect;
  /** Destructive effects (close/delete) require explicit confirmation before applying. */
  destructive: boolean;
  /** A human-readable trace line, shown so the user sees what the bar is doing. */
  summary: string;
  /**
   * Short spoken confirmation for the voice feedback channel (TTS/STS), e.g. "Spawning a codex
   * agent". Distinct from `summary` (the visual trace) so the audio layer never has to reach back
   * into resolve logic — see `src/modules/codecanvas/services/voice/`. Composed centrally by
   * {@link resolveNlIntent} from each intent's {@link IntentDef.speak}.
   */
  speak: string;
  /** Structured, language-neutral description of the action for the localized voice channel
   *  (`services/voice/localize-confirmation.ts`). Attached centrally by {@link resolveNlIntent}. */
  spoken?: SpokenAction;
  /**
   * Optional aggregation hint so a batch of like effects collapses into ONE counted phrase instead of
   * repeating per item — e.g. "spawn 3 codex and 2 claude" → "Spawning 3 Codex agents and 2 Claude
   * agents" (not five separate lines). `verb` is the gerund shown once; `noun` is the SINGULAR thing
   * counted (pluralized by appending "s"). See {@link summarizeResolutions}.
   */
  group?: { verb: string; noun: string };
}

export interface NlCommandContext {
  /** Live agent roster (id + name + status) — the pool for dispatch (running sessions only). */
  roster: AgentStatusSnapshot[];
  /** Every canvas node indexed by name — the pool for focus/close (any node, not just live agents). */
  nodeRefs: CanvasNodeRef[];
  /** Currently-selected ReactFlow nodes, used for deictic commands like "navigate the browser". */
  selectedNodeIds?: readonly string[];
  /**
   * Node ids the previous turn(s) touched and that are still alive — the referents for a
   * `lastMentioned` target ("close them" / "tutup yang tadi"). Pre-computed by the caller from
   * dialogue state (see `canvas-nl-dialogue-state.ts`) so this service stays pure.
   */
  lastMentionedIds?: readonly string[];
  /**
   * Locale-resolved auto-name roster for spawned agents (voice-friendly handles). Injected by the
   * caller so this service stays pure/testable; omitted = the universal default pool.
   */
  namePool?: readonly string[];
  /** Open canvas projects — the pool for `switch_project` / `close_project` name matching. */
  projects?: CanvasProjectRef[];
  /**
   * Id of the currently-active project. Lets `close_project` default to closing the active one, and
   * `switch_project` recognize a request to switch to the project already in view.
   */
  activeProjectId?: string;
  /**
   * Id of the project to return to for an anaphoric switch ("go back", "proyek tadi") — the
   * most-recently-opened project other than the active one. Pre-computed by the caller (from
   * `buildRecentProjects`) so this service stays pure.
   */
  previousProjectId?: string;
}

/** A disambiguation the bar can ask about when a target matched multiple nodes (Option C, ADR-0034). */
export interface ClarifyCandidate {
  id: string;
  label: string;
}
/** What a resolver knows at the ambiguity point; the runner enriches it with the pending intents. */
export interface NlClarifySeed {
  ambiguousName: string;
  candidates: ClarifyCandidate[];
}
/** The full clarification surfaced to the bar: a question + candidates + the intents to re-run on pick. */
export interface NlClarification extends NlClarifySeed {
  question: string;
  intents: NlCanvasIntent[];
}
/** An actionable error, optionally carrying a clarification seed (present only for ambiguous targets). */
export type NlErrorResult = { error: string; clarify?: NlClarifySeed };
/** The batch-level error: like {@link NlErrorResult} but its clarify is fully enriched (question + intents). */
export type NlClarifyError = { error: string; clarify?: NlClarification };

/** Extract clarify candidates from a name/agent resolution — only when it failed as `ambiguous`. */
function candidatesOf(r: NodeNameResolution | AgentNameResolution): ClarifyCandidate[] | undefined {
  if (r.ok || r.reason !== "ambiguous") return undefined;
  return r.candidates.map((c) => ({ id: c.id, label: c.name }));
}

function nameError(
  target: string,
  reason: "not-found" | "ambiguous",
  noun = "node",
  candidates?: ClarifyCandidate[],
): NlErrorResult {
  if (reason === "ambiguous") {
    return {
      error: `Multiple ${noun}s named "${target}" — be more specific.`,
      ...(candidates && candidates.length ? { clarify: { ambiguousName: target, candidates } } : {}),
    };
  }
  return { error: `No ${noun} named "${target}" on the canvas.` };
}

/** Actionable error for an unresolvable PROJECT name (phrased for projects, not canvas nodes). */
function projectNameError(target: string, reason: "not-found" | "ambiguous", candidates?: ClarifyCandidate[]): NlErrorResult {
  if (reason === "ambiguous") {
    return {
      error: `Multiple projects match "${target}" — be more specific.`,
      ...(candidates && candidates.length ? { clarify: { ambiguousName: target, candidates } } : {}),
    };
  }
  return { error: `No open project named "${target}".` };
}

/**
 * Whether a switch_project target is the "previous project" anaphor ("previous"/"last project",
 * "proyek sebelumnya", "proyek tadi") rather than a literal project name. Strips the project noun and
 * checks the REMAINDER is exactly a back-reference word, so a real project named "Last Sprint" (which
 * merely contains "last") is still matched by name, not mistaken for the anaphor.
 */
const PREVIOUS_PROJECT_WORDS = new Set([
  "previous", "prev", "last", "prior", "earlier", "back",
  "sebelumnya", "terakhir", "tadi", "barusan",
]);
function isPreviousProjectTarget(target: string): boolean {
  const rest = normalizeNameQuery(target)
    .split(/\s+/)
    .filter((w) => w && !/^(?:the|project|projects|proyek|canvas|kanvas|workspace|to|ke)$/.test(w))
    .join(" ");
  return PREVIOUS_PROJECT_WORDS.has(rest);
}

function selectedBrowserRef(ctx: NlCommandContext): CanvasNodeRef | null {
  const selected = new Set(ctx.selectedNodeIds ?? []);
  if (selected.size === 0) return null;
  const browsers = uniqueRefs(ctx.nodeRefs.filter((ref) => ref.kind === "browser" && selected.has(ref.id)));
  return browsers.length === 1 ? browsers[0] : null;
}

function onlyBrowserRef(ctx: NlCommandContext): CanvasNodeRef | null {
  const browsers = uniqueRefs(ctx.nodeRefs.filter((ref) => ref.kind === "browser"));
  return browsers.length === 1 ? browsers[0] : null;
}

function resolveBrowserForNavigation(target: string | undefined, ctx: NlCommandContext): CanvasNodeRef | { error: string } {
  if (target) {
    const browser = resolveNodeByName(target, ctx.nodeRefs, { kind: "browser" });
    if (browser.ok) return browser.ref;
    return nameError(target, browser.reason, "browser");
  }

  const selected = selectedBrowserRef(ctx);
  if (selected) return selected;

  const only = onlyBrowserRef(ctx);
  if (only) return only;

  const browserCount = uniqueRefs(ctx.nodeRefs.filter((ref) => ref.kind === "browser")).length;
  return browserCount > 1
    ? { error: "Which browser should I navigate?" }
    : { error: "No browser is open on the canvas." };
}

// ─── Intent Registry ──────────────────────────────────────────────────────────
//
// One declarative entry per intent — the single source of truth that feeds THREE consumers:
//   • the haiku prompt schema (text/STT)         → IntentDef.promptSchema
//   • realtime tool definitions (STS/voice)      → IntentDef.toolParams
//   • parse-time validation + resolution         → IntentDef.parse / IntentDef.resolve
// Adding an intent = adding one entry here; no more editing three parallel switches by hand.
// Voice (STT/STS) only changes how an utterance becomes intents — this contract stays put.

/** Dynamic context the prompt/tool schemas need (live enums vary per canvas). */
export interface IntentParamCtx {
  nodeKinds: readonly CanvasCreateNodeKind[];
  agentNames: string[];
  /** Voice/tool target hints for live agents, e.g. "Bima (Claude 3 / Cloud three)". */
  agentTargetHints?: string[];
  /** Whether a browser node exists; realtime voice hides browser navigation until this is true. */
  hasBrowserNodes?: boolean;
  /** Whether the user is answering a pending target clarification; exposes choose_target. */
  hasPendingClarification?: boolean;
  /** Open project names — surfaced in switch_project's target enum so the planner grounds on them. */
  projectNames?: string[];
  /** Whether project-scoped canvas memory is available; gates the voice remember/recall tools. */
  hasProjectMemory?: boolean;
}

export interface IntentDef {
  /** The `action` discriminant, also the STS tool name. */
  name: NlCanvasIntent["action"];
  /** Human description — used as the STS tool description. */
  description: string;
  /** Whether this effect needs explicit (visual or spoken) confirmation before applying. */
  destructive: boolean;
  /** One JSON-schema line for the haiku prompt (text/STT). May embed live enums from ctx. */
  promptSchema: (ctx: IntentParamCtx) => string;
  /** JSON-schema params for realtime tool-calling (STS). Mirrors promptSchema, machine-readable. */
  toolParams: (ctx: IntentParamCtx) => Record<string, unknown>;
  /** Validate raw model/tool args into a typed intent for this action, or an actionable error. */
  parse: (raw: Record<string, unknown>) => NlCanvasIntent | { error: string };
  /**
   * Resolve the typed intent to an executable effect, or an actionable error. Returns the resolution
   * WITHOUT `speak` — {@link resolveNlIntent} attaches it from {@link IntentDef.speak} so spoken
   * phrasing lives in one place per intent and resolve bodies stay focused on the effect.
   */
  resolve: (intent: NlCanvasIntent, ctx: NlCommandContext) => Omit<NlResolution, "speak"> | NlErrorResult;
  /** Short spoken confirmation for TTS/STS, e.g. "Spawning a codex agent". Audio-optimized phrasing. */
  speak: (intent: NlCanvasIntent) => string;
}

const NODE_KINDS = new Set<string>(CANVAS_CREATE_NODE_KINDS);

/** Trimmed-string accessor: returns the value only when it's a non-empty string. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Brief typed into a live agent's terminal when the user promotes it to lead (`make_lead`). It turns
 * that agent into the fleet orchestrator (the CNVS "Chase" pattern): plan/grill first, then coordinate
 * the other live agents via the `lotus_*` fleet tools. Only Claude-family agents have these tools
 * (they ride the global `~/.claude.json` MCP), so the lead should be a Claude agent.
 */
const ORCHESTRATOR_BRIEF = [
  "You are now the LEAD ORCHESTRATOR for the agents on this canvas. Coordinate the fleet using your",
  "lotus_* tools — delegate the implementation, don't do it all yourself.",
  "",
  "1. Run a short planning/grilling pass with me first: restate the goal, surface risks and unknowns,",
  "   and ask the questions you need before fanning work out.",
  "2. lotus_list_fleet — see which agents already exist before spawning more.",
  "3. Break the work into independent units. For each, either dispatch to an existing agent or",
  "   lotus_spawn_cell with an initialPrompt so the worker boots already working. Pick the runner per task.",
  "4. lotus_dispatch_to_cell with a structured task/goal/doneWhen envelope (not raw text).",
  "5. lotus_gather_results over the worker pane ids to collect every result in one call.",
  "6. Synthesize and report back to me. Spawn workers in parallel when their tasks are independent.",
].join("\n");

/** Brief handed to an agent by the `snapshot_browser` intent. The agent snapshots ITS OWN paired
 *  browser node (1:1 terminal↔browser), reads the returned screenshot image, and describes it. */
const BROWSER_SNAPSHOT_BRIEF = [
  "Take a snapshot of your canvas browser node now: call lotus_canvas_browser_snapshot.",
  "The result includes a line \"📸 Screenshot saved to: <path>\" — read that image file and describe",
  "what is visible on the page (title, key text, buttons/links). Report back concisely.",
].join(" ");

/** Runners spawnable from natural language. `custom` is excluded — it needs an explicit command.
 * Profile wrappers such as CCS/CSP are intentionally not native NL runners; expose them as explicit
 * custom runner commands instead so generic "cloud agent" cannot drift into a profile wrapper. */
export const NL_RUNNERS = ["claude", "codex", "cursor"] as const;
const NL_RUNNER_SET = new Set<string>(NL_RUNNERS);

/**
 * Per-command circuit breaker shared by typed, fast-path, and Live Voice spawning. This is not a
 * canvas-wide agent limit: a human can launch further batches. Fifty matches the unattended MCP
 * session budget while preventing one transcription/model error from starting hundreds of CLIs.
 */
export const MAX_NL_SPAWN_COUNT = 50;

/**
 * Normalize the optional count emitted by structured NL/realtime tools. Accept digit strings from
 * free-form CLI fallbacks, but reject fractional, zero, negative, or oversized batches explicitly so
 * a malformed count can never degrade into a surprising single spawn.
 */
export function parseNlSpawnCount(value: unknown): number | { error: string } {
  if (value === undefined || value === null) return 1;
  const count = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_NL_SPAWN_COUNT) {
    return { error: `I can open 1–${MAX_NL_SPAWN_COUNT} agents at a time.` };
  }
  return count;
}

/**
 * Coerce a free-text runner token to a native runner, or carry it as `runner:"custom"` +
 * `runnerLabel: <token>`; `spawn_agent.resolve` later maps the label to a native runner by alias or
 * fuzzy match, falling back to claude.
 */
const DIAGRAM_NODE_KINDS = new Set(["process", "decision", "terminator", "note"]);

/**
 * Validate/repair the graph the parser model emitted inline for a draw_diagram intent. Keeps only
 * well-formed nodes (id + label) and edges (both endpoints present), so a sloppy model response
 * still yields a drawable graph rather than throwing. Returns null when nothing usable survives.
 */
export function parseDiagramGraph(value: unknown): DiagramGraph | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(raw.nodes)) return null;
  const nodes: DiagramNode[] = [];
  const ids = new Set<string>();
  for (const n of raw.nodes) {
    if (!n || typeof n !== "object") continue;
    const id = str((n as { id?: unknown }).id);
    const label = str((n as { label?: unknown }).label);
    if (!id || ids.has(id)) continue;
    const kindRaw = str((n as { kind?: unknown }).kind);
    const kind = kindRaw && DIAGRAM_NODE_KINDS.has(kindRaw) ? (kindRaw as DiagramNode["kind"]) : undefined;
    ids.add(id);
    nodes.push({ id, label: label ?? id, ...(kind ? { kind } : {}) });
  }
  if (nodes.length === 0) return null;
  const edges: DiagramEdge[] = [];
  if (Array.isArray(raw.edges)) {
    for (const e of raw.edges) {
      if (!e || typeof e !== "object") continue;
      const from = str((e as { from?: unknown }).from);
      const to = str((e as { to?: unknown }).to);
      if (!from || !to) continue;
      const label = str((e as { label?: unknown }).label);
      edges.push({ from, to, ...(label ? { label } : {}) });
    }
  }
  return { nodes, edges };
}

function asRunnerOrCustom(value: unknown): { runner: AgentRunnerType; runnerLabel?: string } {
  const raw = str(value)?.trim();
  const v = raw?.toLowerCase();
  if (v && NL_RUNNER_SET.has(v)) return { runner: v as AgentRunnerType };
  if (raw) return { runner: "custom", runnerLabel: raw };
  return { runner: "claude" };
}

/**
 * Parse a raw `target` arg (from the model/tool call) into an {@link NlTarget}, or null if invalid.
 * Accepts the legacy plain string (→ byName) and the discriminated object form. `byType` with
 * quantifier "count" requires a positive count; anything malformed returns null so the caller emits
 * its own "which node?" error.
 */
function parseNlTargetArg(raw: unknown): NlTarget | null {
  if (typeof raw === "string") {
    const s = raw.trim();
    return s ? { kind: "byName", name: s } : null;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    switch (str(o.kind)) {
      case "byName": {
        const name = str(o.name);
        return name ? { kind: "byName", name } : null;
      }
      case "byType": {
        const nodeType = str(o.nodeType);
        if (!nodeType) return null;
        const quantifier = str(o.quantifier) === "count" ? "count" : "all";
        if (quantifier === "count") {
          const count = typeof o.count === "number" && o.count >= 1 ? Math.floor(o.count) : null;
          return count ? { kind: "byType", nodeType, quantifier, count } : null;
        }
        return { kind: "byType", nodeType, quantifier };
      }
      case "selection":
        return { kind: "selection" };
      case "lastMentioned":
        return { kind: "lastMentioned" };
      default:
        return null;
    }
  }
  return null;
}

/** English phrasing of a close target, for the single-node speak() path (collectives phrase per node). */
function describeCloseTarget(target: string | NlTarget): string {
  const t = normalizeNlTarget(target);
  switch (t.kind) {
    case "byName":
      return t.name;
    case "byType":
      return t.quantifier === "count" ? `${t.count} ${kindNoun(t.nodeType)}s` : `all ${kindNoun(t.nodeType)}s`;
    case "selection":
      return "the selection";
    case "lastMentioned":
      return "them";
  }
}

export const INTENT_REGISTRY: readonly IntentDef[] = [
  {
    name: "create_node",
    description: "Create a new node on the canvas (terminal, note, plan, task, etc.).",
    destructive: false,
    speak: (i) => (i.action === "create_node" ? `Creating a ${i.nodeType} node` : ""),
    promptSchema: (ctx) =>
      `{"action":"create_node","nodeType":<one of: ${ctx.nodeKinds.join(", ")}>,"content":<optional initial text, e.g. a note's body>}`,
    toolParams: (ctx) => ({
      type: "object",
      properties: {
        nodeType: { type: "string", enum: [...ctx.nodeKinds], description: "Kind of node to create." },
        content: { type: "string", description: "Optional initial text (e.g. a note's body)." },
      },
      required: ["nodeType"],
    }),
    parse: (raw) => {
      const nodeType = str(raw.nodeType);
      if (!nodeType || !NODE_KINDS.has(nodeType)) return { error: `Unknown node type "${String(raw.nodeType)}".` };
      const content = str(raw.content);
      return { action: "create_node", nodeType: nodeType as CanvasCreateNodeKind, ...(content ? { content } : {}) };
    },
    resolve: (intent) => {
      if (intent.action !== "create_node") return { error: "intent mismatch" };
      return {
        effect: { kind: "command", command: { kind: "create-node", nodeType: intent.nodeType, content: intent.content, focus: true } },
        destructive: false,
        summary: `Create a ${intent.nodeType} node`,
      };
    },
  },
  {
    name: "arrange",
    description: "Auto-layout / tidy up the whole canvas.",
    destructive: false,
    speak: () => "Arranging the canvas",
    promptSchema: () => `{"action":"arrange"}  (auto-layout / tidy up the whole canvas)`,
    toolParams: () => ({ type: "object", properties: {} }),
    parse: () => ({ action: "arrange" }),
    resolve: () => ({ effect: { kind: "command", command: { kind: "arrange-layout" } }, destructive: false, summary: "Arrange the canvas" }),
  },
  {
    name: "focus",
    description: "Select and focus a node by its name (any node, not just agents).",
    destructive: false,
    speak: (i) => (i.action === "focus" ? `Focusing ${i.target}` : ""),
    promptSchema: () => `{"action":"focus","target":<node name>}`,
    toolParams: () => ({
      type: "object",
      properties: { target: { type: "string", description: "Name of the node to focus." } },
      required: ["target"],
    }),
    parse: (raw) => {
      const target = str(raw.target);
      if (!target) return { error: "Which node should I focus?" };
      return { action: "focus", target };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "focus") return { error: "intent mismatch" };
      const r = resolveNodeByName(intent.target, ctx.nodeRefs);
      if (!r.ok) return nameError(intent.target, r.reason, "node", candidatesOf(r));
      return { effect: { kind: "command", command: { kind: "focus-node", nodeId: r.id } }, destructive: false, summary: `Focus ${r.ref.name}` };
    },
  },
  {
    name: "dispatch",
    description:
      "Send a message to a live agent by name — a task, an instruction, OR a question. A message addressed to an agent (e.g. \"Rowan, …\" or \"ask Sage …\"), including a plain question, is ALWAYS a dispatch — never an error. The agent's terminal is the chat.",
    destructive: false,
    speak: (i) => (i.action === "dispatch" ? `Dispatching to ${i.target}` : ""),
    promptSchema: () => `{"action":"dispatch","target":<agent name>,"task":<the full message to the agent, verbatim>}`,
    toolParams: (ctx) => ({
      type: "object",
      properties: {
        target: {
          type: "string",
          description: `Visible name of the live agent to dispatch to. Prefer visible names over runner labels.${ctx.agentTargetHints?.length ? ` Current agents: ${ctx.agentTargetHints.join("; ")}.` : ""}`,
        },
        task: { type: "string", description: "The full message for the agent — a task to do or a question to answer, copied verbatim." },
      },
      required: ["target", "task"],
    }),
    parse: (raw) => {
      const target = str(raw.target);
      const task = str(raw.task);
      if (!target) return { error: "Which agent should I dispatch to?" };
      if (!task) return { error: "What task should I dispatch?" };
      return { action: "dispatch", target, task };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "dispatch") return { error: "intent mismatch" };
      const r = resolveAgentByName(intent.target, ctx.roster);
      if (!r.ok) return nameError(intent.target, r.reason, "agent", candidatesOf(r));
      const agent = ctx.roster.find((candidate) => candidate.id === r.id);
      return { effect: { kind: "dispatch", agentId: r.id, text: intent.task }, destructive: false, summary: `Dispatch to ${agent?.name ?? intent.target}` };
    },
  },
  {
    name: "snapshot_browser",
    description:
      "Capture a visual snapshot of a canvas browser node: ask a live agent to run lotus_canvas_browser_snapshot, read the screenshot image, and describe the page. Use for 'snapshot the browser' / 'ambil snapshot halaman'. Dispatches to the named agent, or the only live agent if unspecified.",
    destructive: false,
    speak: (i) => (i.action === "snapshot_browser" ? "Taking a browser snapshot" : ""),
    promptSchema: () => `{"action":"snapshot_browser","target":<optional live agent name to run it>}`,
    toolParams: (ctx) => ({
      type: "object",
      properties: {
        target: {
          type: "string",
          description: `Optional visible name of the live agent whose browser to snapshot.${ctx.agentTargetHints?.length ? ` Current agents: ${ctx.agentTargetHints.join("; ")}.` : ""}`,
        },
      },
    }),
    parse: (raw) => {
      const target = str(raw.target);
      return { action: "snapshot_browser", ...(target ? { target } : {}) };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "snapshot_browser") return { error: "intent mismatch" };
      // The agent snapshots ITS OWN paired browser (1:1 terminal↔browser), so we only pick the agent.
      let agentId: string;
      let agentName: string;
      if (intent.target) {
        const r = resolveAgentByName(intent.target, ctx.roster);
        if (!r.ok) return nameError(intent.target, r.reason, "agent", candidatesOf(r));
        agentId = r.id;
        agentName = ctx.roster.find((candidate) => candidate.id === r.id)?.name ?? intent.target;
      } else if (ctx.roster.length === 1) {
        agentId = ctx.roster[0].id;
        agentName = ctx.roster[0].name;
      } else if (ctx.roster.length === 0) {
        return {
          error:
            "No live agent to take the snapshot — spawn an agent first, or use the Screenshot button on the browser node.",
        };
      } else {
        return { error: 'Which agent should take the snapshot? Name it, e.g. "snapshot the browser with Atlas".' };
      }
      return {
        effect: { kind: "dispatch", agentId, text: BROWSER_SNAPSHOT_BRIEF },
        destructive: false,
        summary: `Snapshot the browser via ${agentName}`,
      };
    },
  },
  {
    name: "say_to_agent",
    description:
      "Send an exact short conversational message to a live agent. Use this for greetings like 'say hello to Codex'; do not turn it into a task brief.",
    destructive: false,
    speak: (i) => (i.action === "say_to_agent" ? `Saying that to ${i.target}` : ""),
    promptSchema: () => `{"action":"say_to_agent","target":<agent name>,"message":<exact short message to send>}`,
    toolParams: (ctx) => ({
      type: "object",
      properties: {
        target: {
          type: "string",
          description: `Visible name of the live agent to talk to. Prefer visible names over runner labels.${ctx.agentTargetHints?.length ? ` Current agents: ${ctx.agentTargetHints.join("; ")}.` : ""}`,
        },
        message: { type: "string", description: "Exact short conversational message to send, not an instruction wrapper." },
      },
      required: ["target", "message"],
    }),
    parse: (raw) => {
      const target = str(raw.target);
      const message = str(raw.message);
      if (!target) return { error: "Which agent should I talk to?" };
      if (!message) return { error: "What should I say?" };
      return { action: "say_to_agent", target, message };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "say_to_agent") return { error: "intent mismatch" };
      const r = resolveAgentByName(intent.target, ctx.roster);
      if (!r.ok) return nameError(intent.target, r.reason, "agent", candidatesOf(r));
      const agent = ctx.roster.find((candidate) => candidate.id === r.id);
      return { effect: { kind: "dispatch", agentId: r.id, text: intent.message }, destructive: false, summary: `Say to ${agent?.name ?? intent.target}` };
    },
  },
  {
    name: "close",
    description:
      'Close/delete node(s). Target ONE node by name, or a COLLECTIVE: {"kind":"byType","nodeType":"browser","quantifier":"all"} for "close all browsers" / "tutup semua browser", quantifier "count" with a count for "close 2 browsers", {"kind":"selection"} for "close these". A single close applies immediately; a large collective is confirmed first.',
    destructive: false,
    speak: (i) => (i.action === "close" ? `Closing ${describeCloseTarget(i.target)}` : ""),
    promptSchema: (ctx) =>
      `{"action":"close","target":<a node name (string), OR {"kind":"byType","nodeType":<one of: ${ctx.nodeKinds.join(", ")}>,"quantifier":"all"|"count","count":<n if count>}, OR {"kind":"selection"}>}  (use byType for collectives like "close all browsers" / "tutup semua browser")`,
    toolParams: (ctx) => ({
      type: "object",
      properties: {
        target: {
          description: 'A node name (string) for a single node, or a collective filter object.',
          anyOf: [
            { type: "string", description: "Exact/partial node name for a single node." },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["byType", "selection"] },
                nodeType: { type: "string", enum: [...ctx.nodeKinds, "browser", "terminal", "agent"] },
                quantifier: { type: "string", enum: ["all", "count"] },
                count: { type: "number" },
              },
              required: ["kind"],
            },
          ],
        },
      },
      required: ["target"],
    }),
    parse: (raw) => {
      const target = parseNlTargetArg(raw.target);
      if (!target) return { error: "Which node should I close?" };
      return { action: "close", target };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "close") return { error: "intent mismatch" };
      const target = normalizeNlTarget(intent.target);
      if (target.kind === "byName") {
        const r = resolveNodeByName(target.name, ctx.nodeRefs);
        if (!r.ok) return nameError(target.name, r.reason, "node", candidatesOf(r));
        return { effect: { kind: "command", command: { kind: "close-node", nodeId: r.id } }, destructive: false, summary: `Close ${target.name}` };
      }
      // A collective is fanned out into one close per node by resolveNlIntents; if this single-effect
      // path is reached directly, close the first match so it never crashes or silently no-ops.
      const res = resolveNodesByTarget(target, ctx);
      if (!res.ok) return { error: res.error };
      const ref = res.refs[0];
      return { effect: { kind: "command", command: { kind: "close-node", nodeId: ref.id } }, destructive: false, summary: `Close ${ref.name}` };
    },
  },
  {
    name: "close_all",
    description: 'Close EVERY node on the canvas ("close all", "close everything", "clear the canvas"). Confirmed first (closes everything).',
    destructive: true,
    speak: () => "Closing everything",
    promptSchema: () => `{"action":"close_all"}`,
    toolParams: () => ({ type: "object", properties: {}, required: [] }),
    parse: () => ({ action: "close_all" }),
    resolve: (intent) => {
      if (intent.action !== "close_all") return { error: "intent mismatch" };
      return { effect: { kind: "command", command: { kind: "close-all-nodes" } }, destructive: true, summary: "Close everything" };
    },
  },
  {
    name: "spawn_agent",
    description: "Launch one or more auto-named live agents for a CLI runner (claude, codex, cursor, …), optionally briefed with a first task.",
    destructive: false,
    // Pretty label, matching the grouped-batch phrasing ("a Codex agent", never "a codex agent").
    speak: (i) =>
      i.action === "spawn_agent"
        ? i.brief
          ? `Spawning a ${runnerLabel(i.runner ?? "claude")} agent to ${i.brief}`
          : `Spawning a ${runnerLabel(i.runner ?? "claude")} agent`
        : "",
    promptSchema: () => {
      return `{"action":"spawn_agent","runner":<one of: ${NL_RUNNERS.join(", ")} — default claude>,"count":<optional integer 1-${MAX_NL_SPAWN_COUNT}, default 1>,"model":<optional model id, e.g. "opus" or "claude-opus-4-8">,"brief":<optional first task to start every agent in this group on>}  (for mixed runners, emit one counted spawn_agent intent per runner group)`;
    },
    toolParams: () => ({
      type: "object",
      properties: {
        runner: {
          type: "string",
          enum: [...NL_RUNNERS],
          description: "Which runner/CLI to launch. Defaults to claude.",
        },
        model: { type: "string", description: 'Optional model id to pin (e.g. "opus"). Claude-family runners only; others use the CLI default.' },
        brief: { type: "string", description: "Optional first task the agent starts on once live." },
        count: {
          type: "integer",
          minimum: 1,
          maximum: MAX_NL_SPAWN_COUNT,
          description: "How many agents of this runner to launch. Defaults to 1.",
        },
      },
    }),
    parse: (raw) => {
      const count = parseNlSpawnCount(raw.count);
      if (typeof count === "object") return count;
      const brief = str(raw.brief);
      const model = str(raw.model);
      const { runner, runnerLabel } = asRunnerOrCustom(raw.runner);
      return {
        action: "spawn_agent",
        runner,
        ...(runnerLabel ? { runnerLabel } : {}),
        ...(brief ? { brief } : {}),
        ...(model ? { model } : {}),
      };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "spawn_agent") return { error: "intent mismatch" };
      const takenNames = ctx.nodeRefs.filter((r) => r.kind === "agent").map((r) => r.name);

      // A non-native token: spoken alias → fuzzy native → claude, so a planner typo never dead-ends a spawn.
      let runner: AgentRunnerType = intent.runner;
      const runnerCommand = intent.runnerCommand;
      let displayLabel: string = intent.runnerLabel ?? intent.runner;
      if (runner === "custom" && !runnerCommand) {
        const label = intent.runnerLabel ?? "";
        const alias = resolveRunnerAlias(label);
        const native = alias && NL_RUNNER_SET.has(alias) ? alias : fuzzyMatchName(label, [...NL_RUNNERS]);
        runner = (native as AgentRunnerType) ?? "claude";
        displayLabel = native ?? "claude";
      }

      const definition = buildSpawnFirstAgentDefinition(runner, takenNames, {
        ...(runnerCommand ? { runnerCommand } : {}),
        ...(intent.model ? { model: intent.model } : {}),
        ...(ctx.namePool ? { pool: ctx.namePool } : {}),
      });
      return {
        effect: {
          kind: "command",
          command: {
            kind: "create-agent",
            definition,
            ...(intent.brief ? { brief: intent.brief } : {}),
            focus: true,
          },
        },
        destructive: false,
        summary: `Spawn a ${displayLabel}${intent.model ? ` (${intent.model})` : ""} agent${intent.brief ? ` to: ${intent.brief}` : ""}`,
        // Aggregate multi-spawn batches into one phrase per runner (grouped by runner label).
        group: { verb: "Spawning", noun: `${runnerLabel(displayLabel)} agent` },
      };
    },
  },
  {
    name: "draw_diagram",
    description:
      "Draw a flowchart/diagram DIRECTLY on the canvas. Use for ANY request to draw, sketch, chart, map out, or diagram something — e.g. 'create a flowchart about this project', 'diagram the auth flow', 'gambarkan alur login', 'sketch the architecture'. YOU must produce the diagram content inline as a graph: `nodes` (id, label, kind) and `edges` (from, to, optional label). The canvas lays it out and draws editable shapes — you do NOT compute coordinates. Model the request as best you can from what you know; keep it focused (roughly 4–12 nodes). " +
      "Make it a REAL flowchart, not a straight line: every `decision` node MUST have at least two outgoing edges, each with a short branch label (e.g. 'yes'/'no', 'valid'/'invalid'), and the branches should lead to different nodes (they may rejoin or loop back). Start with a `terminator` (Start) and end with a `terminator` (End).",
    destructive: false,
    speak: (i) => (i.action === "draw_diagram" ? `Drawing a diagram of ${i.topic}` : ""),
    promptSchema: () =>
      `{"action":"draw_diagram","topic":<short subject>,"direction":<"TB"|"LR">,"graph":{"nodes":[{"id":<slug>,"label":<text>,"kind":<"process"|"decision"|"terminator"|"note">}],"edges":[{"from":<id>,"to":<id>,"label":<optional>}]}}  (a real flowchart, not a straight line: every "decision" node needs ≥2 labeled outgoing edges to different nodes)`,
    toolParams: () => ({
      type: "object",
      properties: {
        topic: { type: "string", description: "Short subject of the diagram, for the frame title." },
        direction: { type: "string", enum: ["TB", "LR"], description: "Flow direction: top-to-bottom (default) or left-to-right." },
        diagramType: { type: "string", description: 'Optional kind, e.g. "flowchart", "architecture", "sequence".' },
        graph: {
          type: "object",
          description: "The diagram content YOU generate. Emit relationships, not coordinates.",
          properties: {
            nodes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Unique slug." },
                  label: { type: "string", description: "Text inside the shape." },
                  kind: { type: "string", enum: ["process", "decision", "terminator", "note"] },
                },
                required: ["id", "label"],
              },
            },
            edges: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "string" },
                  label: { type: "string" },
                },
                required: ["from", "to"],
              },
            },
          },
          required: ["nodes"],
        },
      },
      required: ["topic", "graph"],
    }),
    parse: (raw) => {
      const topic = str(raw.topic);
      if (!topic) return { error: "What should I diagram?" };
      const graph = parseDiagramGraph(raw.graph);
      if (!graph) return { error: `I couldn't build a diagram for "${topic}" — try naming the steps or parts you want.` };
      const diagramType = str(raw.diagramType);
      const direction = str(raw.direction)?.toUpperCase();
      return {
        action: "draw_diagram",
        topic,
        graph,
        ...(diagramType ? { diagramType } : {}),
        ...(direction === "LR" || direction === "TB" ? { direction: direction as "LR" | "TB" } : {}),
      };
    },
    resolve: (intent) => {
      if (intent.action !== "draw_diagram") return { error: "intent mismatch" };
      return {
        effect: {
          kind: "command",
          command: {
            kind: "draw-diagram",
            topic: intent.topic,
            graph: intent.graph,
            ...(intent.diagramType ? { diagramType: intent.diagramType } : {}),
            ...(intent.direction ? { direction: intent.direction } : {}),
          },
        },
        destructive: false,
        summary: `Draw a diagram of ${intent.topic}`,
      };
    },
  },
  {
    name: "run_task",
    description: "Dispatch an existing task node to agent(s), found by the task's name.",
    destructive: false,
    speak: (i) =>
      i.action === "run_task" ? `Running task ${i.target}${i.mode === "team" ? " with the team" : ""}` : "",
    promptSchema: () => `{"action":"run_task","target":<task name>,"mode":<"single" (default) | "team">}`,
    toolParams: () => ({
      type: "object",
      properties: {
        target: { type: "string", description: "Name of the task node to run." },
        mode: { type: "string", enum: ["single", "team"], description: 'single = one agent (default); team = the engineering team.' },
      },
      required: ["target"],
    }),
    parse: (raw) => {
      const target = str(raw.target);
      if (!target) return { error: "Which task should I run?" };
      const mode: TaskDispatchMode = str(raw.mode)?.toLowerCase() === "team" ? "team" : "single";
      return { action: "run_task", target, mode };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "run_task") return { error: "intent mismatch" };
      const r = resolveNodeByName(intent.target, ctx.nodeRefs, { kind: "task" });
      if (!r.ok) return nameError(intent.target, r.reason, "task", candidatesOf(r));
      return {
        effect: { kind: "command", command: { kind: "dispatch-task", nodeId: r.id, mode: intent.mode } },
        destructive: false,
        summary: `Run task "${intent.target}" (${intent.mode})`,
      };
    },
  },
  {
    name: "open_browser",
    description: "Open a browser node — standalone, or open/focus one wired to a named terminal.",
    destructive: false,
    speak: (i) =>
      i.action === "open_browser"
        ? i.target
          ? `Opening a browser on ${i.target}`
          : i.url
            ? `Opening a browser at ${i.url}`
            : "Opening a browser"
        : "",
    promptSchema: () => `{"action":"open_browser","url":<optional url>,"target":<optional terminal name to attach to>}`,
    toolParams: () => ({
      type: "object",
      properties: {
        url: { type: "string", description: "Optional URL to open (defaults to a blank page)." },
        target: { type: "string", description: "Optional terminal name to attach or focus the browser on." },
      },
    }),
    parse: (raw) => {
      const url = str(raw.url);
      const target = str(raw.target);
      return { action: "open_browser", ...(url ? { url: normalizeBrowserUrl(url) } : {}), ...(target ? { target } : {}) };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "open_browser") return { error: "intent mismatch" };
      if (intent.target) {
        const browser = resolveNodeByName(intent.target, ctx.nodeRefs, { kind: "browser" });
        if (browser.ok) {
          return {
            effect: {
              kind: "command",
              command: intent.url
                ? { kind: "navigate-browser-node", nodeId: browser.id, url: intent.url }
                : { kind: "focus-node", nodeId: browser.id },
            },
            destructive: false,
            summary: intent.url ? `Open ${intent.url} in ${browser.ref.name}` : `Focus ${browser.ref.name}`,
          };
        }
        const r = resolveNodeByName(intent.target, ctx.nodeRefs, { kind: "terminal" });
        if (!r.ok) return nameError(intent.target, r.reason, "browser or terminal", candidatesOf(r));
        return {
          effect: { kind: "command", command: { kind: "open-browser-for-terminal", terminalId: r.id, url: intent.url } },
          destructive: false,
          summary: `Open browser on ${intent.target}`,
        };
      }
      return {
        effect: { kind: "command", command: { kind: "create-browser", url: intent.url, focus: true } },
        destructive: false,
        summary: intent.url ? `Open browser at ${intent.url}` : "Open a browser",
      };
    },
  },
  {
    name: "navigate_browser",
    description: "Navigate an existing browser node to a URL. If no target is named, use the selected browser or the only browser on the canvas.",
    destructive: false,
    speak: (i) =>
      i.action === "navigate_browser"
        ? `Navigating ${i.target ?? "the browser"} to ${i.url}`
        : "",
    promptSchema: () => `{"action":"navigate_browser","url":<required url or site name>,"target":<optional browser name, e.g. "Browser 1">}`,
    toolParams: () => ({
      type: "object",
      properties: {
        url: { type: "string", description: "URL or site name to navigate to, e.g. https://youtube.com or YouTube." },
        target: { type: "string", description: 'Optional browser node name, e.g. "Browser 1". Omit to use the selected browser.' },
      },
      required: ["url"],
    }),
    parse: (raw) => {
      const url = str(raw.url);
      const target = str(raw.target);
      if (!url) return { error: "Where should I navigate the browser?" };
      return { action: "navigate_browser", url: normalizeBrowserUrl(url), ...(target ? { target } : {}) };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "navigate_browser") return { error: "intent mismatch" };
      if (intent.target) {
        const browser = resolveNodeByName(intent.target, ctx.nodeRefs, { kind: "browser" });
        if (browser.ok) {
          return {
            effect: { kind: "command", command: { kind: "navigate-browser-node", nodeId: browser.id, url: intent.url } },
            destructive: false,
            summary: `Navigate ${browser.ref.name} to ${intent.url}`,
          };
        }
        const terminal = resolveNodeByName(intent.target, ctx.nodeRefs, { kind: "terminal" });
        if (terminal.ok) {
          return {
            effect: { kind: "command", command: { kind: "open-browser-for-terminal", terminalId: terminal.id, url: intent.url } },
            destructive: false,
            summary: `Navigate browser on ${terminal.ref.name} to ${intent.url}`,
          };
        }
        return nameError(intent.target, browser.reason, "browser or terminal");
      }
      const browser = resolveBrowserForNavigation(intent.target, ctx);
      if ("error" in browser) return browser;
      return {
        effect: { kind: "command", command: { kind: "navigate-browser-node", nodeId: browser.id, url: intent.url } },
        destructive: false,
        summary: `Navigate ${browser.name} to ${intent.url}`,
      };
    },
  },
  {
    name: "recover",
    description: "Reconnect a disconnected terminal or browser node by name.",
    destructive: false,
    speak: (i) => (i.action === "recover" ? `Recovering ${i.target}` : ""),
    promptSchema: () => `{"action":"recover","target":<terminal or browser name>}`,
    toolParams: () => ({
      type: "object",
      properties: { target: { type: "string", description: "Name of the terminal or browser to recover." } },
      required: ["target"],
    }),
    parse: (raw) => {
      const target = str(raw.target);
      if (!target) return { error: "Which terminal or browser should I recover?" };
      return { action: "recover", target };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "recover") return { error: "intent mismatch" };
      const r = resolveNodeByName(intent.target, ctx.nodeRefs, { kind: ["terminal", "browser"] });
      if (!r.ok) return nameError(intent.target, r.reason, "terminal or browser", candidatesOf(r));
      const command: CanvasCommand =
        r.ref.kind === "browser"
          ? { kind: "recover-browser", nodeId: r.id }
          : { kind: "recover-terminal", nodeId: r.id };
      return { effect: { kind: "command", command }, destructive: false, summary: `Recover ${intent.target}` };
    },
  },
  {
    name: "make_lead",
    description:
      "Promote a live agent to lead orchestrator: it plans/grills, then coordinates the other agents " +
      "via the lotus_* fleet tools. Best on a Claude agent (only Claude has the fleet tools).",
    destructive: false,
    speak: (i) => (i.action === "make_lead" ? `Making ${i.target} the lead` : ""),
    promptSchema: () => `{"action":"make_lead","target":<live agent name to promote to lead orchestrator>}`,
    toolParams: () => ({
      type: "object",
      properties: { target: { type: "string", description: "Name of the live agent to make the lead orchestrator." } },
      required: ["target"],
    }),
    parse: (raw) => {
      const target = str(raw.target);
      if (!target) return { error: "Which agent should I make the lead?" };
      return { action: "make_lead", target };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "make_lead") return { error: "intent mismatch" };
      const r = resolveAgentByName(intent.target, ctx.roster);
      if (!r.ok) return nameError(intent.target, r.reason, "agent", candidatesOf(r));
      return {
        effect: { kind: "dispatch", agentId: r.id, text: ORCHESTRATOR_BRIEF },
        destructive: false,
        summary: `Make ${intent.target} the lead orchestrator`,
      };
    },
  },
  ...frameIntentDefs({ str, resolveNodeByName, nameError, candidatesOf }),
  {
    name: "switch_project",
    description: "Switch the active canvas to another open project by name (e.g. \"switch to project Beta\").",
    destructive: false,
    speak: (i) => (i.action === "switch_project" ? `Switching to ${i.target}` : ""),
    promptSchema: (ctx) =>
      `{"action":"switch_project","target":<project name${ctx.projectNames && ctx.projectNames.length ? `, one of: ${ctx.projectNames.join(", ")}` : ""}>}`,
    toolParams: (ctx) => ({
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Name of the project to switch to.",
          ...(ctx.projectNames && ctx.projectNames.length ? { enum: ctx.projectNames } : {}),
        },
      },
      required: ["target"],
    }),
    parse: (raw) => {
      const target = str(raw.target);
      if (!target) return { error: "Which project should I switch to?" };
      return { action: "switch_project", target };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "switch_project") return { error: "intent mismatch" };
      const projects = ctx.projects ?? [];
      // Anaphoric "go back to the previous project" — resolve against the pre-computed previous id.
      if (isPreviousProjectTarget(intent.target)) {
        if (!ctx.previousProjectId) return { error: "No previous project to go back to." };
        const prev = projects.find((p) => p.id === ctx.previousProjectId);
        return {
          effect: { kind: "app", command: { type: "switch-project", projectId: ctx.previousProjectId } },
          destructive: false,
          summary: `Switch to ${prev?.name ?? "the previous project"}`,
        };
      }
      if (projects.length === 0) return { error: "No projects are open to switch to." };
      const r = resolveProjectByName(intent.target, projects);
      if (!r.ok) return projectNameError(intent.target, r.reason, candidatesOf(r));
      // Switching to the project already in view is a harmless no-op downstream — say so plainly
      // rather than announce a switch that does nothing.
      const summary = r.id === ctx.activeProjectId ? `Already on ${r.ref.name}` : `Switch to ${r.ref.name}`;
      return {
        effect: { kind: "app", command: { type: "switch-project", projectId: r.id } },
        destructive: false,
        summary,
      };
    },
  },
  {
    name: "open_page",
    description: "Open an app page: the canvas Settings, or the Canvases gallery to browse projects.",
    destructive: false,
    speak: (i) => (i.action === "open_page" ? (i.page === "settings" ? "Opening settings" : "Opening the canvas gallery") : ""),
    promptSchema: () => `{"action":"open_page","page":"settings"|"canvases"}`,
    toolParams: () => ({
      type: "object",
      properties: { page: { type: "string", enum: ["settings", "canvases"], description: "Which app page to open." } },
      required: ["page"],
    }),
    parse: (raw) => {
      const page = str(raw.page)?.toLowerCase();
      if (page === "settings" || page === "canvases") return { action: "open_page", page };
      return { error: 'Which page — "settings" or "canvases"?' };
    },
    resolve: (intent) => {
      if (intent.action !== "open_page") return { error: "intent mismatch" };
      return {
        effect: { kind: "app", command: { type: "open-page", page: intent.page } },
        destructive: false,
        summary: intent.page === "settings" ? "Open settings" : "Open the canvas gallery",
      };
    },
  },
  {
    name: "new_project",
    description: "Create/open a new canvas project (prompts for a project folder).",
    destructive: false,
    speak: () => "Creating a new project",
    promptSchema: () => `{"action":"new_project"}`,
    toolParams: () => ({ type: "object", properties: {} }),
    parse: () => ({ action: "new_project" }),
    resolve: (intent) => {
      if (intent.action !== "new_project") return { error: "intent mismatch" };
      return { effect: { kind: "app", command: { type: "new-project" } }, destructive: false, summary: "New project" };
    },
  },
  {
    name: "close_project",
    description: "Close a project. Defaults to the current project; name one to close it specifically.",
    destructive: true,
    speak: (i) => (i.action === "close_project" ? `Closing ${i.target ?? "this project"}` : ""),
    promptSchema: () => `{"action":"close_project","target":<optional project name; omit for the current project>}`,
    toolParams: () => ({
      type: "object",
      properties: { target: { type: "string", description: "Optional project name. Omit to close the current project." } },
    }),
    parse: (raw) => {
      const target = str(raw.target);
      return { action: "close_project", ...(target ? { target } : {}) };
    },
    resolve: (intent, ctx) => {
      if (intent.action !== "close_project") return { error: "intent mismatch" };
      if (intent.target) {
        const projects = ctx.projects ?? [];
        if (projects.length === 0) return { error: "No projects are open." };
        const r = resolveProjectByName(intent.target, projects);
        if (!r.ok) return projectNameError(intent.target, r.reason, candidatesOf(r));
        return {
          effect: { kind: "app", command: { type: "close-project", projectId: r.id } },
          destructive: true,
          summary: `Close ${r.ref.name}`,
        };
      }
      if (!ctx.activeProjectId) return { error: "No project is open to close." };
      return {
        effect: { kind: "app", command: { type: "close-project", projectId: ctx.activeProjectId } },
        destructive: true,
        summary: "Close the current project",
      };
    },
  },
];

/** Registry lookup by action name — used by the parser and resolver. */
export const intentByName: ReadonlyMap<string, IntentDef> = new Map(INTENT_REGISTRY.map((d) => [d.name, d]));

/**
 * Language-neutral descriptor for the localized voice channel, derived from the typed intent (plus
 * the resolution for spawn, whose runner label is only known after custom-runner resolution — it is
 * carried in `group.noun` as "<Label> agent"). English phrasing stays in {@link IntentDef.speak};
 * this feeds `localize-confirmation.ts` for id/ja. Returns undefined only for an unknown action.
 */
function spokenActionFor(intent: NlCanvasIntent, resolution: Omit<NlResolution, "speak">): SpokenAction | undefined {
  switch (intent.action) {
    case "spawn_agent":
      return { kind: "spawn", runner: (resolution.group?.noun ?? "agent").replace(/\s*agents?$/i, "").trim() || "agent" };
    case "create_node":
      return { kind: "create", nodeType: intent.nodeType };
    case "arrange":
      return { kind: "arrange" };
    case "focus":
      return { kind: "focus", target: intent.target };
    case "dispatch":
      return { kind: "dispatch", target: intent.target };
    case "say_to_agent":
      return { kind: "say_to_agent", target: intent.target };
    case "close":
      return { kind: "close", target: describeCloseTarget(intent.target) };
    case "close_all":
      return { kind: "close_all" };
    case "run_task":
      return { kind: "run_task", target: intent.target, team: intent.mode === "team" };
    case "open_browser":
      return { kind: "open_browser", ...(intent.target ? { target: intent.target } : {}) };
    case "navigate_browser":
      return { kind: "navigate_browser", target: intent.target ?? "the browser", url: intent.url };
    case "snapshot_browser":
      // Spoken as a dispatch (it IS a dispatch to an agent) — reuses the localizer's dispatch phrasing.
      return { kind: "dispatch", target: intent.target ?? "the agent" };
    case "recover":
      return { kind: "recover", target: intent.target };
    case "make_lead":
      return { kind: "make_lead", target: intent.target };
    case "switch_project":
      return { kind: "switch_project", target: intent.target };
    case "open_page":
      return { kind: "open_page", page: intent.page };
    case "new_project":
      return { kind: "new_project" };
    case "close_project":
      return { kind: "close_project", ...(intent.target ? { target: intent.target } : {}) };
    default:
      return undefined;
  }
}

/** Resolves a parsed NL intent into an executable effect, or an actionable error (with optional
 *  clarification seed when the target was ambiguous). */
export function resolveNlIntent(intent: NlCanvasIntent, ctx: NlCommandContext): NlResolution | NlErrorResult {
  const def = intentByName.get(intent.action);
  if (!def) return { error: "That request isn't supported by the command bar yet." };
  const r = def.resolve(intent, ctx);
  if ("error" in r) return r;
  // Attach the spoken confirmation centrally so each resolve body stays effect-focused: the English
  // `speak` string, and a language-neutral `spoken` descriptor for the localized voice channel.
  const spoken = spokenActionFor(intent, r);
  return { ...r, speak: def.speak(intent), ...(spoken ? { spoken } : {}) };
}

/**
 * Placeholder node-id for a node CREATED earlier in the same batch. `resolveNlIntents` predicts each
 * spawn's auto-assigned name and grows a working node index, so a later step ("…and focus Iris") can
 * resolve against a sibling that doesn't exist on the canvas yet. The real id isn't known until the
 * create executes, so the target carries this placeholder; the executor rebinds it to the real id at
 * apply time (see `bindBatchNodeIds` in canvas-nl-runner.ts). Index = the creating resolution's index.
 */
export const BATCH_NODE_PREFIX = "__nl_batch_";
export const batchNodeId = (index: number): string => `${BATCH_NODE_PREFIX}${index}`;
export const isBatchNodeId = (id: string): boolean => id.startsWith(BATCH_NODE_PREFIX);
export const batchNodeIndex = (id: string): number | null => {
  if (!isBatchNodeId(id)) return null;
  const n = Number.parseInt(id.slice(BATCH_NODE_PREFIX.length), 10);
  return Number.isInteger(n) ? n : null;
};

/**
 * One close resolution for a single node in a fanned-out collective close. Carries a `group` so a batch
 * of these collapses into one counted phrase ("Closing 3 browsers") via {@link summarizeResolutions},
 * grouped by node kind so a mixed selection reads "Closing 2 browsers and 1 terminal".
 */
function closeResolutionFor(ref: CanvasNodeRef, destructive: boolean): NlResolution {
  const noun = kindNoun(ref.kind);
  return {
    effect: { kind: "command", command: { kind: "close-node", nodeId: ref.id } },
    destructive,
    summary: `Close ${ref.name}`,
    speak: `Closing ${ref.name}`,
    spoken: { kind: "close", target: ref.name },
    group: { verb: "Closing", noun },
  };
}

/**
 * Closing this many nodes at once (or more) asks for one confirmation first — blast-radius, not verb,
 * decides destructiveness (a single named close stays immediate). See plan §Slice 5.
 */
export const COLLECTIVE_CLOSE_CONFIRM_MIN = 3;

/** A node a resolution will create, predicted so later in-batch intents can target it by name. */
function predictedNodeRef(effect: NlEffect, index: number): CanvasNodeRef | null {
  if (effect.kind !== "command" || effect.command.kind !== "create-agent") return null;
  const name = effect.command.definition.name?.trim();
  if (!name) return null;
  return { id: batchNodeId(index), kind: "agent", name };
}

/**
 * Resolves a LIST of intents into ordered effects. Intents resolve in order against a working canvas
 * index that GROWS as create-intents are planned — so a compound request like "open three claude and
 * focus Iris" sees the just-spawned Iris (its auto-name is deterministic, computed at resolve time)
 * and targets it via a {@link batchNodeId} placeholder the executor rebinds to the real id. Still
 * fails atomically on a genuinely unresolvable name so the bar never applies a half-understood request.
 */
/** Compose the spoken/visible disambiguation prompt from the candidate labels. */
function buildClarifyQuestion(seed: NlClarifySeed): string {
  const labels = seed.candidates.map((c) => c.label);
  const list =
    labels.length <= 1
      ? labels.join("")
      : labels.length === 2
        ? `${labels[0]} or ${labels[1]}`
        : `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
  return `Which one — ${list}?`;
}

export function resolveNlIntents(intents: NlCanvasIntent[], ctx: NlCommandContext): NlResolution[] | NlClarifyError {
  if (intents.length === 0) return { error: "Nothing to do." };
  const resolutions: NlResolution[] = [];
  const working: CanvasNodeRef[] = [...ctx.nodeRefs];
  for (const intent of intents) {
    const stepCtx: NlCommandContext = {
      roster: ctx.roster,
      nodeRefs: working,
      selectedNodeIds: ctx.selectedNodeIds,
      lastMentionedIds: ctx.lastMentionedIds,
      namePool: ctx.namePool,
      projects: ctx.projects,
      activeProjectId: ctx.activeProjectId,
      previousProjectId: ctx.previousProjectId,
    };
    // A collective close ("close all browsers" / "close these") fans out into one close-node effect
    // per matched node, so the batch's grouped feedback reads "Closing 3 browsers" and the single
    // per-batch destructive confirmation still gates the whole set. Resolved here (not in the
    // single-effect intent resolver) because it is inherently multi-effect.
    if (intent.action === "close" && isCollectiveTarget(intent.target)) {
      const res = resolveNodesByTarget(normalizeNlTarget(intent.target), stepCtx);
      if (!res.ok) return { error: res.error };
      const destructive = res.refs.length >= COLLECTIVE_CLOSE_CONFIRM_MIN;
      for (const ref of res.refs) resolutions.push(closeResolutionFor(ref, destructive));
      continue;
    }
    const r = resolveNlIntent(intent, stepCtx);
    if ("error" in r) {
      // A single ambiguous target becomes a clarification (Option C): carry the candidates + the
      // pending intent so the bar can ask and re-run on the user's pick. Multi-intent batches keep a
      // plain error (disambiguating one step of many is not worth the interaction).
      if (r.clarify && intents.length === 1) {
        return { error: r.error, clarify: { ...r.clarify, question: buildClarifyQuestion(r.clarify), intents } };
      }
      return { error: r.error };
    }
    const predicted = predictedNodeRef(r.effect, resolutions.length);
    resolutions.push(r);
    if (predicted) working.push(predicted);
  }
  return resolutions;
}

// ─── Feedback aggregation ───────────────────────────────────────────────────────

const RUNNER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",

  custom: "Agent",
};
/** Human label for a runner used in spoken/visible feedback (e.g. "codex" → "Codex"). */
function runnerLabel(runner: string): string {
  return RUNNER_LABELS[runner] ?? (runner.charAt(0).toUpperCase() + runner.slice(1));
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun.trim()) ? "an" : "a";
}
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Collapses a resolved batch into concise trace + spoken feedback. Adjacent resolutions sharing a
 * {@link NlResolution.group} (verb + singular noun) are counted into one phrase, and consecutive
 * groups with the same verb share that verb once — so "spawn 3 codex and 2 claude" reads as
 * "Spawning 3 Codex agents and 2 Claude agents" instead of five repeated lines. Ungrouped resolutions
 * pass through with their own `summary` (trace) / `speak` (voice), preserving batch order. Pure.
 */
export function summarizeResolutions(batch: NlResolution[]): { trace: string; speak: string } {
  type Run =
    | { kind: "group"; verb: string; noun: string; count: number }
    | { kind: "item"; summary: string; speak: string };
  const runs: Run[] = [];
  for (const r of batch) {
    const last = runs[runs.length - 1];
    if (r.group) {
      if (last?.kind === "group" && last.verb === r.group.verb && last.noun === r.group.noun) {
        last.count += 1;
      } else {
        runs.push({ kind: "group", verb: r.group.verb, noun: r.group.noun, count: 1 });
      }
    } else {
      runs.push({ kind: "item", summary: r.summary, speak: r.speak });
    }
  }

  const nounPhrase = (noun: string, count: number) =>
    count === 1 ? `${article(noun)} ${noun}` : `${count} ${noun}s`;

  const traceSegs: string[] = [];
  const speakSegs: string[] = [];
  for (let i = 0; i < runs.length; ) {
    const run = runs[i];
    if (run.kind === "item") {
      traceSegs.push(run.summary);
      if (run.speak) speakSegs.push(run.speak);
      i++;
      continue;
    }
    // Coalesce adjacent groups that share this verb into one phrase ("Spawning A and B").
    const verb = run.verb;
    const nouns: string[] = [];
    for (; i < runs.length; i++) {
      const g = runs[i];
      if (g.kind !== "group" || g.verb !== verb) break;
      nouns.push(nounPhrase(g.noun, g.count));
    }
    const phrase = `${verb} ${joinAnd(nouns)}`;
    traceSegs.push(phrase);
    speakSegs.push(phrase);
  }
  return { trace: traceSegs.join(" · "), speak: speakSegs.join(". ") };
}
