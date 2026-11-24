/**
 * Voice → Terminal Agent prompt composition (CNVS parity).
 *
 * What lands in a live agent's chat when the user speaks should read like the user typed it: clean
 * first-person prose, in the user's own language, carrying every detail. Raw STT is not that — it
 * carries fillers, false starts, missing punctuation, and a relay frame ("tell Rowan that…") whose
 * routing has ALREADY been consumed into the dispatch target, so leaving it in makes the reading
 * agent see itself described in third person.
 *
 * This is delivery cleanup, NOT summarisation — the distinction is the whole point. The sibling
 * `dictation-polish.ts` holds the same meaning-preserving contract for the Dictate path; this module
 * adds the two things a dispatch needs on top: de-framing, and a fidelity guard that rejects a
 * composition which collapsed the request into a summary.
 *
 * Order matters upstream: `compileAgentDelegation` scores the RAW transcript for accumulator
 * corruption FIRST, and only a clean verdict reaches this module. Composing first would let the model
 * quietly de-duplicate that corruption and hide it from the integrity gate.
 *
 * Three layers, so neither a model outage nor a bad rewrite can cost fidelity:
 *  1. `stripLeadingAddressingFrame` — deterministic, local, always applied.
 *  2. the model rewrite — best-effort polish on top, on a hard deadline, failing open to layer 1.
 *  3. `judgeVoiceComposition` — a deterministic fidelity verdict on the result; a composition that
 *     lost a concrete detail, dropped a prohibition, summarised, or invented scope is discarded
 *     back to layer 1 (see `voice-dispatch-fidelity-guard.ts`).
 */

import { hasVagueReference, workspaceContextLines, type WorkspaceContext } from "../refine-dispatch-prompt";
import {
  judgeVoiceComposition,
  wordCount,
  type VoiceFidelityFailure,
  type VoiceFidelityVerdict,
} from "./voice-dispatch-fidelity-guard";

export interface VoiceDispatchComposeOptions {
  /** Visible name of the agent that will READ this prompt — it is the addressee, not a third party. */
  target: string;
  /** Project name for light grounding context. */
  projectName?: string | null;
  /** Live workspace facts. Used ONLY when the speech contains a deictic reference to resolve. */
  workspace?: WorkspaceContext;
  /** Canvas vocabulary (agent + node names) the model may correct obvious mis-hearings toward. */
  vocabulary?: readonly string[];
  /**
   * Hard ceiling on the model leg before the locally de-framed transcript is delivered instead.
   * Polish is a nice-to-have; a dispatch the user is waiting on out loud is not.
   */
  timeoutMs?: number;
}

/** Below this word count, speech with no filler and no relay frame is already a clean command. */
const MIN_WORDS_TO_COMPOSE = 8;

/**
 * The compose leg sits behind the 0.9–1.5s transcript grace-wait, and the user is waiting in
 * conversation for the dispatch to be acknowledged. The NL transport's own budget is far larger (8s
 * HTTP, then a cold CLI spawn), so without a deadline of our own a degraded backend turns a polish
 * step into a multi-second silence. Failing open here costs the polish and nothing else.
 */
const DEFAULT_COMPOSE_TIMEOUT_MS = 6_000;

/**
 * Speech fillers whose presence alone justifies a compose round-trip even on a short utterance —
 * they are exactly what makes a transcript read as dictation rather than as a written instruction.
 */
const FILLER_RE = /\b(?:um+|uh+|er+|ehm+|hmm+|eh|anu|gitu|kayak|you know|i mean|sort of|kind of)\b/i;

/**
 * Relay verbs that hand a message to someone else. Deliberately excludes verbs that could be the
 * task itself ("check", "review") — this list only matches speech that is routing, not working.
 */
const RELAY_VERBS = [
  "prompt", "tell", "ask", "message", "dm", "inform", "remind", "notify",
  "bilang", "sampaikan", "beritahu", "beritau", "kasitau", "kasih tahu", "tanya", "tanyakan", "suruh", "minta",
];

/** Soft lead-ins that precede the relay verb and carry no task content. */
const LEAD_IN_WORDS = [
  "hey", "ok", "okay", "oke", "um", "uh", "so", "well", "please", "jadi", "tolong", "coba", "eh",
];

/**
 * Tokens that must never be taken for the addressee. Without this, "ask me before you change
 * anything" would be de-framed into "before you change anything" — a reversal of meaning, which is
 * precisely the class of bug an aggressive rewrite is supposed to avoid.
 */
const NON_NAME_TOKENS = new Set([
  "me", "us", "you", "him", "her", "them", "someone", "anyone", "everyone", "the", "a", "an", "this", "that",
  "saya", "aku", "kami", "kita", "kamu", "dia", "mereka", "orang", "semua", "siapa",
]);

/** Connectors that bridge the addressee and the actual request, e.g. "tell Rowan THAT …". */
const FRAME_CONNECTORS = ["that", "to", "bahwa", "untuk", "kalau", "kalo", "supaya", "agar", "buat"];

/**
 * Sequencers must never be mistaken for a vocative: "First, run the tests" is ordering information,
 * not an address, and dropping it silently reorders the user's request. Pure fillers ("okay", "so")
 * are deliberately NOT listed — removing those is the intended cleanup.
 */
const SEQUENCER_WORDS = new Set([
  "first", "firstly", "second", "secondly", "third", "next", "then", "later", "finally", "lastly", "afterwards",
  "pertama", "kedua", "ketiga", "lalu", "terus", "kemudian", "selanjutnya", "akhirnya", "setelahnya", "berikutnya",
]);

const alternation = (words: readonly string[]) => words.map((w) => w.replace(/\s/g, "\\s+")).join("|");

const RELAY_FRAME_RE = new RegExp(
  `^(?:(?:${alternation(LEAD_IN_WORDS)})[,\\s]+)*` +
    `(?:(?:can|could|would|will)\\s+you\\s+)?(?:please\\s+)?` +
    `(?:${alternation(RELAY_VERBS)})\\s+` +
    `(?:(?:ke(?:pada)?|to)\\s+)?` +
    `([\\p{L}][\\p{L}\\p{M}'-]{1,24})` +
    `[,:\\s]+(?:(?:${alternation(FRAME_CONNECTORS)})\\s+)?`,
  "iu",
);

/** A bare vocative address: "Rowan, run the tests". */
const VOCATIVE_RE = /^([\p{L}][\p{L}\p{M}'-]{1,24})\s*[,:]\s+/u;

/**
 * Removes a leading relay/vocative frame so the request reads as spoken TO the agent. Returns the
 * input unchanged whenever stripping would leave nothing behind (a frame-only utterance such as
 * "tell Rowan" carries no task) or whenever the apparent addressee is a pronoun or a sequencer.
 *
 * `knownNames` (the canvas roster) makes the bare-vocative branch precise instead of heuristic: with
 * a roster in hand, only a real teammate name counts as an address. Without one it falls back to the
 * sequencer/pronoun guards, which is the conservative direction — a missed strip costs a stray
 * "Rowan," in the prompt; a wrong strip costs meaning.
 */
export function stripLeadingAddressingFrame(transcript: string, knownNames?: readonly string[]): string {
  const text = transcript.trim();
  if (!text) return transcript;
  const roster = new Set((knownNames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean));

  for (const pattern of [RELAY_FRAME_RE, VOCATIVE_RE]) {
    const match = pattern.exec(text);
    if (!match) continue;
    const addressee = match[1]?.toLowerCase();
    if (!addressee || NON_NAME_TOKENS.has(addressee) || SEQUENCER_WORDS.has(addressee)) continue;
    // A bare vocative is only an address when the roster confirms it; a relay verb is evidence enough
    // on its own ("tell Marshall that…" names its addressee explicitly).
    if (pattern === VOCATIVE_RE && roster.size > 0 && !roster.has(addressee)) continue;
    const rest = text.slice(match[0].length).trim();
    if (rest) return rest;
  }
  return text;
}

/**
 * True when the speech is worth a compose round-trip. A short, filler-free, un-framed command
 * ("run the tests") is already the prose we want, so it dispatches instantly with no model call —
 * that is what keeps terse voice commands feeling immediate.
 */
export function shouldComposeVoicePrompt(transcript: string, knownNames?: readonly string[]): boolean {
  const text = transcript.trim();
  if (!text) return false;
  if (wordCount(text) >= MIN_WORDS_TO_COMPOSE) return true;
  if (FILLER_RE.test(text)) return true;
  return stripLeadingAddressingFrame(text, knownNames) !== text;
}

/**
 * One worked example, taken from the behaviour this feature is modelled on. A rewrite contract this
 * strict is far more stable with a single concrete before/after than with more rules: the example
 * demonstrates the two judgement calls prose alone keeps getting wrong — an abandoned false start is
 * *deleted* ("then it will automatically,") while the sentence the speaker actually completed is
 * kept whole, and a spoken technical term is written the way an engineer types it ("the terminal
 * user interface" → "the terminal UI").
 */
const WORKED_EXAMPLE = [
  "Example.",
  "Speech: so can you prompt Marshall that I have this weird bug right now where if I have the canvases in stage mode, if I flip back and forth between canvases, then it will automatically, the terminal user interface on the terminal that is up in stage mode when I switch to the canvas will be completely blank, it doesn't render, until I flip back and forth between different terminals or from stage to grid mode then it will load, I think it's some sort of issue where when I flip from canvas to canvas while stage mode is enabled that first terminal that is being shown does not render properly, can you go surgical with this and find the root of the problem",
  "Prompt: I have this weird bug right now where if I have the canvases in stage mode, if I flip back and forth between canvases, then the terminal UI on the terminal that is up in stage mode when I switch to the canvas will be completely blank — it doesn't render, until I flip back and forth between different terminals or from stage to grid mode, then it will load. I think it's some sort of issue where, when I flip from canvas to canvas while stage mode is enabled, that first terminal being shown does not render properly. Can you go surgical with this and find the root of the problem?",
].join("\n");

/** Build the compose prompt. Pure + testable. */
export function buildVoiceDispatchComposePrompt(
  transcript: string,
  opts: VoiceDispatchComposeOptions,
): string {
  const target = opts.target.trim();
  const reader = target || "the agent";
  const vocab = (opts.vocabulary ?? []).map((s) => s.trim()).filter(Boolean);
  // Grounding is the ONE narrow exception to "add nothing": it is offered only when the speech
  // actually leans on unstated context, so a self-contained request never sees workspace facts it
  // could be tempted to fold in as new scope.
  const grounding = hasVagueReference(transcript)
    ? workspaceContextLines({ projectName: opts.projectName, workspace: opts.workspace })
    : [];

  return [
    `You turn dictated speech into the written prompt that ${target || "a coding agent"} will read in their terminal chat.`,
    `Write exactly what the speaker would have typed to ${reader} if they had typed it instead of said it. You are rewriting the delivery, never the request.`,
    "",
    "Clean up the delivery:",
    "- remove filler words and verbal tics (um, uh, like, you know, jadi, anu, gitu, ya);",
    "- restore the punctuation, capitalization, and sentence breaks that speech cannot carry, and fix obvious spelling slips;",
    "- honour self-corrections, which come in two kinds: delete a false start the speaker abandoned and replaced, and keep a clarification they meant to add, joined with an em-dash;",
    `- drop any addressing or relay frame ("tell ${reader} that…", "bilang ke ${target || "dia"} bahwa…"): the request has already been routed, so ${reader} is the reader of this message, never a third person spoken about.`,
    "",
    "Write technical speech the way an engineer types it — dictation mangles exactly the tokens that matter most:",
    '- spelled-out or spoken-out names collapse to their written form: "user interface" → UI, "see ess ess" → CSS, "type script" → TypeScript, "jason" → JSON;',
    '- dictated paths and filenames become real ones: "source slash modules slash voice" → src/modules/voice, "auth dot ts" → auth.ts;',
    '- dictated symbols and flags become symbols: "dash dash verbose" → --verbose, "at latest" → @latest;',
    "- correct a mis-heard technical term only when the intended one is unmistakable from context; when in doubt, keep what was said.",
    "",
    "Fidelity is absolute — everything below outranks every cleanup rule above:",
    "- keep the speaker's first person voice: they are talking about their own machine, work, and intent;",
    "- write in the same language the speaker used, and keep their register — a blunt request stays blunt, never made polite, formal, or corporate;",
    "- keep every detail: entities, numbers, file paths, versions, caveats, negations, boundaries, and any requested output format, in the order they were said;",
    '- keep the speaker\'s own certainty: a hedge ("I think it\'s some sort of issue where…") tells the agent how sure they are and must survive as a hedge;',
    "- never summarise, shorten, expand, reorder into a plan, answer, or act on the request — you are only rewriting it;",
    "- add nothing the speaker did not say: no requirement, no acceptance criterion, no pleasantry, no closing line.",
    ...(grounding.length > 0
      ? [
          "",
          "Use the context below ONLY to resolve a vague reference into something concrete. It is reference, not a license to add tasks the speaker never requested.",
          ...grounding,
        ]
      : []),
    ...(vocab.length > 0
      ? [
          "",
          `Known names on this canvas — correct obvious mis-hearings toward these, but never invent or insert them: ${vocab.join(", ")}.`,
        ]
      : []),
    "",
    WORKED_EXAMPLE,
    "",
    "Output ONLY the rewritten prompt as plain prose: no heading, no preamble, no quotes around it, no code fences, no note about what you changed. Use a list only if the speaker actually dictated distinct steps.",
    "",
    // The example above carries its own "Speech:" label, so the real input needs a marker that cannot
    // be mistaken for a continuation of it.
    "Now rewrite the speech below.",
    `Speech: ${transcript.trim()}`,
  ].join("\n");
}

/** Strip wrapping code fences / quotes a model sometimes adds despite instructions. */
function unwrap(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Why the delivered text is what it is. Every value but `composed` means the fallback was used. */
export type VoiceComposeOutcome =
  /** The model polished the speech and the fidelity guard accepted the result. */
  | "composed"
  /** Short, filler-free, un-framed speech — already the prose we want, so no model call was made. */
  | "skipped"
  /** The model returned nothing usable. */
  | "empty"
  /** The model leg exceeded `timeoutMs`. */
  | "timeout"
  /** The model call threw. */
  | "error"
  /** The fidelity guard rejected the composition; `failure` says which invariant broke. */
  | "rejected";

export interface VoiceDispatchComposition {
  /** The text to deliver to the agent. Never empty for non-empty speech. */
  text: string;
  outcome: VoiceComposeOutcome;
  /** Present when `outcome === "rejected"` — which fidelity invariant the composition broke. */
  failure?: VoiceFidelityFailure;
  /** The guard's full verdict when one was computed, for diagnostics. */
  verdict?: VoiceFidelityVerdict;
  /** Wall-clock cost of the model leg, when one ran. */
  modelMs?: number;
}

const TIMED_OUT = Symbol("compose-timeout");

/** Race a promise against a deadline. The loser is abandoned, never cancelled — `callModel` owns its
 *  own transport cleanup, and a late reply simply has nowhere to go. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Compose the prompt a live agent will read, reporting how the text was arrived at.
 *
 * Always returns usable text. The locally de-framed transcript is delivered whenever the model is
 * skipped, times out, errors, returns nothing, or returns something the fidelity guard rejects —
 * the user's own words are never worse than correct, so every failure mode lands there.
 */
export async function composeVoiceDispatchPromptDetailed(
  transcript: string,
  callModel: (prompt: string) => Promise<string>,
  opts: VoiceDispatchComposeOptions,
): Promise<VoiceDispatchComposition> {
  const raw = transcript.trim();
  if (!raw) return { text: "", outcome: "skipped" };
  // The dispatch target is an addressee by definition, so it joins the roster used to recognise a bare
  // vocative even when the canvas vocabulary was not supplied.
  const roster = [opts.target, ...(opts.vocabulary ?? [])];
  const fallback = stripLeadingAddressingFrame(raw, roster);
  if (!shouldComposeVoicePrompt(raw, roster)) return { text: fallback, outcome: "skipped" };

  const startedAt = Date.now();
  let result: string | typeof TIMED_OUT;
  try {
    result = await withDeadline(
      callModel(buildVoiceDispatchComposePrompt(raw, opts)),
      opts.timeoutMs ?? DEFAULT_COMPOSE_TIMEOUT_MS,
    );
  } catch {
    return { text: fallback, outcome: "error", modelMs: Date.now() - startedAt };
  }
  const modelMs = Date.now() - startedAt;
  if (result === TIMED_OUT) return { text: fallback, outcome: "timeout", modelMs };

  const composed = unwrap(result);
  if (!composed) return { text: fallback, outcome: "empty", modelMs };

  // The guard scores the composition against the RAW speech, not against the de-framed fallback: the
  // frame carries no facts, so including it would only skew the length ratio.
  const verdict = judgeVoiceComposition(raw, composed);
  if (!verdict.ok) return { text: fallback, outcome: "rejected", failure: verdict.failure, verdict, modelMs };
  return { text: composed, outcome: "composed", verdict, modelMs };
}

/** Text-only wrapper over {@link composeVoiceDispatchPromptDetailed} for callers that need no diagnostics. */
export async function composeVoiceDispatchPrompt(
  transcript: string,
  callModel: (prompt: string) => Promise<string>,
  opts: VoiceDispatchComposeOptions,
): Promise<string> {
  return (await composeVoiceDispatchPromptDetailed(transcript, callModel, opts)).text;
}
