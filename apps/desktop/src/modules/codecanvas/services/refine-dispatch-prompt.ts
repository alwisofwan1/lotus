import type { NlResolution } from "./canvas-nl-command";
import {
  compileAgentDelegation,
  hasExplicitDelegationConstraint,
} from "./voice/agent-delegation-compiler";
import { judgeVoiceComposition } from "./voice/voice-dispatch-fidelity-guard";

/**
 * Dispatch prompt refinement (NL → agent, Fase 1).
 *
 * Between intent resolution and delivery, a substantial dispatch message is rewritten by a fast model
 * into a clearer, better-structured instruction the agent can act on directly — the CNVS pattern. It is
 * SILENT (no preview/edit step, by design) and always fails open: any error, timeout, or empty result
 * falls back to the original text so a dispatch is never blocked or lost.
 *
 * Deliberately conservative to avoid inflating terse commands into generic "AI slop":
 *  - Short messages (< MIN_WORDS_TO_REFINE) pass through untouched — they are already crisp.
 *  - A "verbatim"/"as-is" escape hatch in the utterance skips refinement entirely.
 *  - Explicit messages with NO vague reference pass through untouched (W1a): refining a self-contained
 *    instruction ("refactor the auth module and add tests") only adds a cold model round-trip for
 *    near-zero gain — a capable coding agent acts on clear instructions natively. Refinement earns its
 *    latency only when there's a deictic reference ("this", "it", "everything") to ground.
 *  - The rewrite preserves intent + concrete details and never invents scope (see the system prompt).
 *
 * Fase 2 will enrich the context (git status, recent commits, selected nodes, task criteria).
 */

/** Below this word count a dispatch message is already direct; refining it only risks padding. */
export const MIN_WORDS_TO_REFINE = 6;

/** User asked for the message to go through unchanged — honor it, skip the rewrite. */
const VERBATIM_RE = /\b(verbatim|word[\s-]for[\s-]word|as[\s-]is|exactly as|persis|apa adanya)\b/i;

/**
 * Deictic / under-specified references that only make sense against unstated context ("fix this",
 * "make it faster", "test everything"). Their presence is what makes grounding (git state, selection)
 * worth a model round-trip. High-precision on purpose — a benign complementizer "that" or existential
 * "there" is excluded so self-contained instructions skip refinement and dispatch instantly.
 */
const VAGUE_REFERENCE_RE =
  /\b(this|these|those|it|its|it's|them|the same|the rest|the whole thing|everything|the former|the latter|the previous|the above|the below|aforementioned)\b/i;

/** True when a dispatch task leans on unstated context that refinement could ground. */
export function hasVagueReference(task: string): boolean {
  return VAGUE_REFERENCE_RE.test(task);
}

/**
 * Live workspace facts injected into the rewrite so the result can be concrete (Fase 2). The model
 * uses these ONLY to resolve vague references ("this", "everything") — never to add new scope.
 */
export interface WorkspaceContext {
  git?: {
    branch?: string;
    ahead?: number;
    behind?: number;
    upstream?: string;
    /** Total changed (uncommitted) files. */
    changedCount?: number;
    /** A bounded sample of changed file paths (relative). */
    changedFiles?: string[];
  };
  /** Labels of nodes currently selected on the canvas, e.g. "agent Skye", "task: Fix auth". */
  selection?: string[];
}

/**
 * Profile of the target agent (Fase 3). Lets the rewrite be FRAMED for how this specific agent works
 * — its runner, role, and skills hint at its strengths — rather than one-size-fits-all. Dynamic: the
 * model adapts framing from these facts; we never impose fixed tone/brevity rules.
 */
export interface AgentProfile {
  name?: string;
  /** Team role if known (e.g. "reviewer", "planner"). */
  role?: string;
  /** CLI runner, e.g. "claude" | "codex" | "custom". */
  runner?: string;
  model?: string;
  /** Applied skill names — a strong signal of the agent's focus. */
  skills?: string[];
}

export interface RefineContext {
  /** The full original utterance — used for the verbatim escape and intent fidelity. */
  rawQuery: string;
  /** Light project context (cwd basename) injected into the rewrite. */
  projectName?: string | null;
  /** Resolves a dispatch effect's agentId to the target agent's profile, for addressing + framing. */
  agentProfile?: (agentId: string) => AgentProfile | undefined;
  /** The model caller (same fast model as the NL classifier). */
  callModel: (prompt: string) => Promise<string>;
  /**
   * Lazily gathers live workspace context (git state, selection). Called at most ONCE per batch, and
   * only when at least one dispatch is actually eligible for refinement — so non-dispatch / short /
   * verbatim requests never pay for a git round-trip. Failures fall through (context is best-effort).
   */
  getWorkspace?: () => Promise<WorkspaceContext | undefined>;
}

export function looksVerbatim(raw: string): boolean {
  return VERBATIM_RE.test(raw);
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

const REFINEMENT_STOP_WORDS = new Set([
  "please", "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "with",
  "this", "that", "these", "those", "it", "its", "them", "tolong", "dan", "atau", "yang",
  "ini", "itu", "dengan", "untuk", "pada", "secara",
]);

function refinementAnchors(value: string): Set<string> {
  return new Set(
    (value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
      .filter((word) => word.length >= 3 && !REFINEMENT_STOP_WORDS.has(word)),
  );
}

/** Model refinement may reorder/rephrase, but it must retain most concrete task words. */
function preservesRefinementAnchors(original: string, candidate: string): boolean {
  const anchors = [...refinementAnchors(original)];
  if (anchors.length === 0) return true;
  const retained = refinementAnchors(candidate);
  const matches = anchors.filter((word) => retained.has(word)).length;
  return matches >= Math.max(1, Math.ceil(anchors.length * 0.5));
}

/**
 * Renders the live workspace facts as prose lines. Shared with the voice compose path
 * (`voice/voice-dispatch-compose.ts`) so both rewrites ground deictic references against an
 * identically-phrased snapshot of the repo — one formatter, not two drifting ones.
 */
export function workspaceContextLines(opts: { agent?: AgentProfile; projectName?: string | null; workspace?: WorkspaceContext }): string[] {
  const lines: string[] = [];

  const agent = opts.agent;
  if (agent?.name || agent?.runner) {
    const head = agent.name ? `The instruction goes to ${agent.name}` : "The instruction goes to a coding agent";
    const runnerBit = agent.runner ? `, a ${agent.runner} agent` : "";
    const modelBit = agent.model ? ` (model ${agent.model})` : "";
    lines.push(`${head}${runnerBit}${modelBit}.`);
  }
  if (agent?.role) lines.push(`Its role on the team: ${agent.role}.`);
  if (agent?.skills && agent.skills.length > 0) lines.push(`Its applied skills: ${agent.skills.join(", ")}.`);
  if (opts.projectName) lines.push(`It is working in the project "${opts.projectName}".`);

  const git = opts.workspace?.git;
  if (git?.branch) {
    const bits = [`on branch ${git.branch}`];
    if (git.ahead) bits.push(`${git.ahead} ahead`);
    if (git.behind) bits.push(`${git.behind} behind`);
    const count = git.changedCount ?? git.changedFiles?.length ?? 0;
    if (count > 0) {
      const sample = git.changedFiles && git.changedFiles.length > 0
        ? ` (${git.changedFiles.join(", ")}${count > git.changedFiles.length ? ", …" : ""})`
        : "";
      bits.push(`${count} uncommitted file${count === 1 ? "" : "s"}${sample}`);
    } else {
      bits.push("working tree clean");
    }
    lines.push(`Repo state: ${bits.join(", ")}.`);
  }

  const selection = opts.workspace?.selection;
  if (selection && selection.length > 0) lines.push(`Selected on the canvas: ${selection.join("; ")}.`);

  return lines;
}

export function buildRefinePrompt(
  task: string,
  opts: { agent?: AgentProfile; projectName?: string | null; workspace?: WorkspaceContext },
): string {
  const context = workspaceContextLines(opts);

  const rules = [
    "- Preserve the user's intent and EVERY concrete detail (names, versions, file paths, numbers). Never invent scope, tasks, or requirements the user did not imply.",
    "- Stay as close to the user's own words as possible. Rewrite ONLY what is vague, out of order, or implied-but-unstated; if a phrase is already clear, keep it.",
    "- Match the user's length and register: a one-sentence ask returns one sentence — never expand a short request into a list or a paragraph. Only a genuinely multi-step request becomes a short ordered list.",
    "- Every sentence must add information the agent needs to act. No restating the goal, no filler, no meta-instructions about tone, length, or format — only the task itself.",
    // Grounding rule only when there IS context to ground against.
    ...(context.length > 0
      ? ['- Use the context below ONLY to make the instruction concrete (resolve vague references like "this" or "everything") and to frame it for how the target agent works (its role, runner, and skills). It is reference — never a license to add tasks the user did not request.']
      : []),
    "- Output ONLY the rewritten instruction: no preamble, no surrounding quotes, no code fences, no notes about what you changed.",
  ];

  return [
    "You rewrite a user's instruction to a coding agent the way a senior engineer writes a terse, precise task to a teammate: unambiguous, ordered, and free of any word that does not change what the agent will do.",
    "",
    "Rules:",
    ...rules,
    ...(context.length > 0 ? ["", "Workspace context:", ...context] : []),
    "",
    `User instruction:\n${task}`,
  ].join("\n");
}

/** Strip wrapping code fences / quotes a model sometimes adds despite instructions. */
function cleanModelOutput(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Rewrite a single dispatch message. Always returns usable text (original on any failure). */
export async function refineDispatchText(
  task: string,
  ctx: {
    agent?: AgentProfile;
    projectName?: string | null;
    workspace?: WorkspaceContext;
    callModel: (prompt: string) => Promise<string>;
  },
): Promise<string> {
  const original = task.trim();
  if (!original) return task;
  try {
    const out = await ctx.callModel(
      buildRefinePrompt(original, { agent: ctx.agent, projectName: ctx.projectName, workspace: ctx.workspace }),
    );
    const cleaned = cleanModelOutput(out);
    return cleaned.length > 0
      && judgeVoiceComposition(original, cleaned).ok
      && preservesRefinementAnchors(original, cleaned)
      ? cleaned
      : original;
  } catch {
    return original;
  }
}

/**
 * Refines the dispatch effects in a resolved NL batch (returns a new batch). Non-dispatch effects and
 * short/verbatim dispatches pass through untouched, so terse commands stay instant.
 */
export async function refineDispatchBatch(batch: NlResolution[], ctx: RefineContext): Promise<NlResolution[]> {
  if (looksVerbatim(ctx.rawQuery)) return batch;

  const isModelEligible = (res: NlResolution) =>
    res.effect.kind === "dispatch" &&
    wordCount(res.effect.text) >= MIN_WORDS_TO_REFINE &&
    hasVagueReference(res.effect.text);
  const isStructuredEligible = (res: NlResolution) =>
    res.effect.kind === "dispatch" &&
    !hasVagueReference(res.effect.text) &&
    hasExplicitDelegationConstraint(res.effect.text);
  if (!batch.some((res) => isModelEligible(res) || isStructuredEligible(res))) return batch;

  // Gather live workspace context once, only now that we know we'll refine. Best-effort: any failure
  // just means a less-grounded (but still cleaner) rewrite.
  let workspace: WorkspaceContext | undefined;
  if (batch.some(isModelEligible) && ctx.getWorkspace) {
    try {
      workspace = await ctx.getWorkspace();
    } catch {
      workspace = undefined;
    }
  }

  return Promise.all(
    batch.map(async (res) => {
      if (res.effect.kind !== "dispatch") return res;
      const agent = ctx.agentProfile?.(res.effect.agentId);
      if (isStructuredEligible(res)) {
        const compiled = compileAgentDelegation({
          target: agent?.name ?? res.effect.agentId,
          transcript: res.effect.text,
          language: "auto",
        });
        // Typed text is already written prose — an envelope only earns its place when the capture
        // itself is suspect (cut-off tail, corrupted). A clean compilation passes straight through.
        if (compiled.mode !== "structured") return res;
        return { ...res, effect: { ...res.effect, text: compiled.workerMessage } };
      }
      if (!isModelEligible(res)) return res;
      const refined = await refineDispatchText(res.effect.text, {
        agent,
        projectName: ctx.projectName,
        workspace,
        callModel: ctx.callModel,
      });
      if (refined === res.effect.text) return res;
      return { ...res, effect: { ...res.effect, text: refined } };
    }),
  );
}
