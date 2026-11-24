import type { TranscriptIntegrityQuality, TranscriptIntegrityVerdict } from "./transcript-integrity";
import { scoreTranscriptIntegrity } from "./transcript-integrity";

export interface AgentDelegationPacket {
  target: string;
  objective: string;
  context: string[];
  constraints: string[];
  doneWhen: string[];
  reportBack: {
    format: string;
    evidenceRequired: string[];
  };
  /** Explicit boundaries/negations the model heard, rendered as bullets under the objective. */
  keyConstraints: string[];
  sourceTranscript: string;
  /** True when the authoritative transcript never arrived (STT race) — the verbatim section is omitted. */
  transcriptPending: boolean;
  /** True when `sourceTranscript` looks cut off mid-sentence — a cut-off note is appended for the worker. */
  suspectTail: boolean;
  /**
   * Outcome of scoring `sourceTranscript` for accumulator-style corruption (repetition, growing-prefix
   * duplication, length disproportion — see `transcript-integrity.ts`). "degraded" omits the verbatim
   * block from the rendered worker message; the objective + keyConstraints still carry the assignment
   * as long as `objectiveTrusted` is also true.
   */
  transcriptQuality: TranscriptIntegrityQuality;
  /**
   * False when `transcriptQuality` is "degraded" AND no independent objective (`groundedTask`/`intent`)
   * was supplied. In that case the naive fallback objective would BE the corrupted transcript, so
   * `objective` is instead a placeholder that says scope could not be recovered — there is nothing
   * salvageable in this packet. Callers should treat `mode === "unusable"` as "withhold dispatch, ask
   * the user to repeat the request" rather than sending it to a worker.
   */
  objectiveTrusted: boolean;
  /** Full scoring verdict (quality + machine-readable reasons + metrics) behind `transcriptQuality`, for diagnostics. */
  transcriptIntegrity: TranscriptIntegrityVerdict;
  language: string;
}

export interface CompileAgentDelegationInput {
  target: string;
  transcript: string;
  language: string;
  /** Optional grounded objective; the source transcript remains authoritative and verbatim. */
  groundedTask?: string;
  /** Model's short intent label (one sentence, user's language) — a summary, never a transcript copy. */
  intent?: string;
  /** Explicit boundaries/negations the model heard, e.g. "analisis saja, jangan ubah kode". */
  keyConstraints?: string[];
  /** True when the authoritative transcript never arrived (STT race); transcript may then be "". */
  transcriptPending?: boolean;
}

export interface CompiledAgentDelegation {
  /**
   * "direct": the normal path — a clean, complete capture delivered as the user's own words. The
   * caller polishes delivery first (`voice-dispatch-compose.ts`); nothing is added around it.
   * "structured": the capture is pending, looks cut off, is corrupted-but-backed-by-an-objective, or
   * an independent grounded objective was supplied. Still delivered as prose (see
   * `formatWorkerMessage`) — the difference from "direct" is that the caller must NOT run the compose
   * rewrite, because the text is either not the user's own words or is known to be incomplete.
   * "unusable": the transcript looked corrupted AND there was no independent objective to fall back on
   * — the packet has no trustworthy scope at all; withhold dispatch instead of sending it.
   */
  mode: "direct" | "structured" | "unusable";
  packet: AgentDelegationPacket;
  workerMessage: string;
}

const AUTHORITATIVE_CONTEXT =
  "Treat the authoritative source transcript as the complete scope of this assignment.";
const FIDELITY_CONSTRAINT =
  "Preserve every explicit constraint, negation, exact entity, number, path, version, and requested boundary from the authoritative source transcript.";
const DONE_WHEN =
  "Address every explicit requested output and constraint in the authoritative source transcript with evidence.";
const EXPLICIT_CONSTRAINT_RE =
  /\b(?:do not|don't|never|without|jangan|tanpa|analisis saja|analysis only|analyze only)\b/i;

export function hasExplicitDelegationConstraint(value: string): boolean {
  return EXPLICIT_CONSTRAINT_RE.test(value);
}

const SUSPECT_TAIL_ELLIPSIS_RE = /(?:\.\.\.|…)$/;
/** Dangling conjunctions/prepositions (Indonesian + English) that signal a cut-off transcript tail. */
const DANGLING_CONJUNCTION_WORDS = new Set([
  "dan", "atau", "lalu", "terus", "kemudian", "yang", "untuk", "dengan", "ke", "sama", "tapi",
  "and", "or", "then", "to", "with", "for", "but",
]);

/** True when a transcript looks cut off mid-sentence: trailing ellipsis, or a dangling conjunction. */
export function hasSuspectTranscriptTail(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (SUSPECT_TAIL_ELLIPSIS_RE.test(trimmed)) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const lastWord = words[words.length - 1];
  if (!lastWord) return false;
  const stripped = lastWord.replace(/[.,!?;:]+$/, "").toLowerCase();
  return DANGLING_CONJUNCTION_WORDS.has(stripped);
}

/**
 * Capture caveats, written as the user would write them.
 *
 * All three are deliberately SHORT, parenthetical, and TRAILING. What lands in an agent's chat is a
 * message from a person, so a caveat about the microphone belongs where a person would put it — at
 * the end, as an aside — not as a header above the request. Trailing also keeps the language and
 * register cue coming from the user's own words first, which is what stops an English preamble from
 * steering the reply away from the language the user actually spoke.
 */
const CUT_OFF_NOTE =
  "(Heads up: my message may have been cut off at the end — check with me before you act on the last part.)";
/** Degraded transcript, but an independent objective (groundedTask/intent) exists — scope survives. */
const DEGRADED_TRANSCRIPT_NOTE =
  "(Dictated by voice: the verbatim capture came through garbled, so the above is a summary of what I said rather than my exact words — ask me if anything is ambiguous.)";
/** The transcript never arrived at all, so the objective is the model's paraphrase of the speech. */
const PENDING_TRANSCRIPT_NOTE =
  "(Dictated by voice: this is a summary of what I said, not my exact words — ask me if anything is ambiguous.)";
/**
 * Degraded transcript AND no independent objective — there is nothing left to paraphrase from, so this
 * must not claim one exists. Says plainly that scope could not be recovered. In practice the live
 * voice controller withholds this packet entirely (`mode === "unusable"`) rather than sending it.
 */
const UNRECOVERABLE_MESSAGE =
  "(Dictated by voice, but the capture came through garbled and I could not recover what I asked for. Please ask me to repeat the request.)";
const UNRECOVERABLE_OBJECTIVE_TEXT =
  "Unable to determine — the captured request looked corrupted and no independent objective was available. Ask the user to repeat the request.";

/** Join fragments into flowing text: each gets terminal punctuation so they don't run together. */
function asSentence(value: string): string {
  const text = value.trim();
  if (!text) return "";
  return /[.!?…:;]$/.test(text) ? text : `${text}.`;
}

/**
 * Renders the message a live agent will actually read. It is PROSE in every mode — never a markdown
 * relay envelope.
 *
 * The old rendering wrapped everything in `# Delegated voice task`, an `Objective:` line, constraint
 * bullets, a `## User's words (authoritative, verbatim)` section and a closing fidelity nag. That is
 * a form, and it arrives in a chat window where every other message is a human typing. It also
 * shipped TWO renditions of one request whenever a transcript was present — a paraphrase and the
 * verbatim words — leaving the agent to guess which one was authoritative.
 *
 * So there are exactly two shapes now:
 *  • a trustworthy verbatim capture exists → it IS the message, and nothing is rendered alongside it
 *    (the objective and constraints stay packet metadata; the spoken sentence already carries them);
 *  • no usable capture → the paraphrase plus any explicit boundaries the model heard, both already in
 *    the user's own language, followed by one short note saying the wording is approximate.
 */
function formatWorkerMessage(packet: AgentDelegationPacket): string {
  const isDegraded = packet.transcriptQuality === "degraded";

  if (!packet.transcriptPending && !isDegraded) {
    return packet.suspectTail ? `${packet.sourceTranscript}\n\n${CUT_OFF_NOTE}` : packet.sourceTranscript;
  }

  if (isDegraded && !packet.objectiveTrusted) return UNRECOVERABLE_MESSAGE;

  const request = [packet.objective, ...packet.keyConstraints].map(asSentence).filter(Boolean).join(" ");
  return `${request}\n\n${isDegraded ? DEGRADED_TRANSCRIPT_NOTE : PENDING_TRANSCRIPT_NOTE}`;
}

/**
 * Compiles an authoritative user instruction into a complete worker-facing task contract. Spoken
 * reply budgets are intentionally absent from this interface and cannot truncate the worker payload.
 */
export function compileAgentDelegation({
  target,
  transcript,
  language,
  groundedTask,
  intent,
  keyConstraints,
  transcriptPending,
}: CompileAgentDelegationInput): CompiledAgentDelegation {
  const sourceTranscript = transcript.trim();
  const groundedObjective = groundedTask?.trim();
  const intentObjective = intent?.trim();
  const hasIndependentObjective = Boolean(groundedObjective || intentObjective);
  const normalizedKeyConstraints = (keyConstraints ?? []).map((value) => value.trim()).filter(Boolean);
  const suspectTail = hasSuspectTranscriptTail(sourceTranscript);
  const isPending = Boolean(transcriptPending) || sourceTranscript.length === 0;

  // Fallback objective if no independent one is given — NOT yet trusted; see objectiveTrusted below.
  const fallbackObjective = groundedObjective || intentObjective || sourceTranscript;

  // ONLY a groundedTask may serve as the length-disproportion baseline, never `intent`.
  //
  // The dispatch tool defines `intent` as a one-sentence LABEL ("never a transcript copy" — see
  // s2s-canvas-tool-executor.ts), so the ratio between it and real speech is large BY CONSTRUCTION:
  // 615 characters of ordinary dictation behind a 52-character label scores 11.8 against a threshold
  // of 6. Feeding `intent` in here therefore degraded essentially every long spoken request, dropped
  // the user's own words as "unreliable", and delivered the 52-character label in their place —
  // the exact opposite of what this whole path is for.
  //
  // Nothing is lost by narrowing it. Accumulator duplication is a SHAPE problem, and the two
  // repetition detectors that target it (`repeatedNGramRatio`, `repeatedPrefixRatio`) need no length
  // baseline at all; the disproportion signal only ever made sense against an independent objective
  // of comparable scope, which is what `groundedTask` is and what `intent` is not.
  const transcriptIntegrity: TranscriptIntegrityVerdict = scoreTranscriptIntegrity({
    transcript: sourceTranscript,
    objective: groundedObjective,
  });
  const transcriptQuality: TranscriptIntegrityQuality = transcriptIntegrity.quality;

  // False only when the corruption gate fired AND there is no independent objective to fall back on —
  // in that case fallbackObjective IS the corrupted transcript, so it must not be rendered as-is.
  const objectiveTrusted = hasIndependentObjective || transcriptQuality === "clean";
  const objective = objectiveTrusted ? fallbackObjective : UNRECOVERABLE_OBJECTIVE_TEXT;

  // Speech that arrived clean and complete is delivered as the user's own words, polished by the
  // compose stage. The gate is about TRUST, not length — a 90-word request is still just the user
  // talking. It closes only when something is actually wrong with the capture (pending / cut-off /
  // corrupted), or when an independent grounded objective was supplied, since the caller's own
  // grounding must not then be overwritten by a second rewrite.
  const direct = !groundedObjective && !isPending && !suspectTail && transcriptQuality === "clean";

  const packet: AgentDelegationPacket = {
    target: target.trim(),
    objective,
    context: [AUTHORITATIVE_CONTEXT],
    constraints: [FIDELITY_CONSTRAINT],
    doneWhen: [DONE_WHEN],
    reportBack: {
      format: "Use the report format explicitly requested in the authoritative source transcript.",
      evidenceRequired: ["Provide evidence for every requested finding or deliverable."],
    },
    keyConstraints: normalizedKeyConstraints,
    sourceTranscript,
    transcriptPending: isPending,
    suspectTail,
    transcriptQuality,
    objectiveTrusted,
    transcriptIntegrity,
    language,
  };

  const mode: CompiledAgentDelegation["mode"] = direct ? "direct" : objectiveTrusted ? "structured" : "unusable";

  return {
    mode,
    packet,
    workerMessage: direct ? sourceTranscript : formatWorkerMessage(packet),
  };
}
