/**
 * Immutable accumulator for the authoritative Live Voice user transcript.
 *
 * Server VAD can split one long utterance into several `isFinal` segments; only merging (rather than
 * blind-appending) consecutive segments keeps the full utterance available to the dispatch packet
 * without corrupting it. See `plans/voice-dispatch-payload-integrity/PLAN.md` for the incident this
 * rewrite fixes: a provider that resends a *cumulative* snapshot on every final segment (proven for
 * xAI's `grok-transcribe`, see `transcript-provider-semantics.ts`) made the old blind-concat
 * accumulator grow quadratically, and a too-weak turn boundary let a barged-in pleasantry from a prior
 * turn ride along into a real work packet.
 *
 * The buffer is internally a list of segments (not a single string) so it can:
 *  - collapse a cumulative resend instead of concatenating it (overlap collapse),
 *  - replace a single item's text when its `itemId` recurs (replace-by-item),
 *  - drop an exact repeat (idempotent),
 *  - cap total size with visible, never-silent eviction,
 *  - expire a turn on a time gap or an agent barge-in boundary, regardless of whether the agent's
 *    reply ever *completed*.
 *
 * `text` and `stale` stay present on every returned buffer for backward compatibility with existing
 * call sites and tests. `segments`/`truncated` are only present once there is a turn in progress —
 * an empty/fresh buffer is exactly `{ text: null, stale: false }`, matching the original shape.
 */

export interface S2sUserTranscriptSegment {
  readonly text: string;
  /** Provider item identity, when known (Slice 1). Enables replace-by-item merging. */
  readonly itemId?: string;
  /** Injected-clock timestamp (ms) this segment was appended/refined at, when a clock was supplied. */
  readonly at?: number;
}

export interface S2sUserTranscriptBuffer {
  text: string | null;
  stale: boolean;
  /** Present only while a turn has at least one segment. */
  segments?: readonly S2sUserTranscriptSegment[];
  /** Present (and `true`) only once a cap has evicted a segment. Never set to `false` — omitted instead. */
  truncated?: boolean;
  /**
   * Armed by {@link markAgentAudioStarted}: the *next* appended user segment starts a new turn even
   * though the agent's reply never fully completed. Cleared the moment that next segment lands.
   */
  turnBoundaryArmed?: boolean;
}

/** A segment arriving more than this many ms after the previous one starts a new turn. Overridable via options. */
export const TURN_GAP_MS = 45_000;

/** Default cap on segments retained per turn. Overridable via options. */
export const DEFAULT_MAX_SEGMENTS = 40;

/** Default cap on total joined-text characters retained per turn. Overridable via options. */
export const DEFAULT_MAX_CHARS = 4_000;

export interface AppendFinalUserTranscriptOptions {
  /** Provider item identity for this segment (Slice 1), enabling replace-by-item merging. */
  itemId?: string;
  /** Injected clock reading (ms) for this append. Omit to skip time-based turn expiry entirely — this
   *  module never calls `Date.now()` itself. */
  now?: number;
  /** Turn-gap threshold in ms. Defaults to {@link TURN_GAP_MS}. Only consulted when `now` is supplied. */
  turnGapMs?: number;
  /** Max segments retained per turn. Defaults to {@link DEFAULT_MAX_SEGMENTS}. */
  maxSegments?: number;
  /** Max joined-text characters retained per turn. Defaults to {@link DEFAULT_MAX_CHARS}. */
  maxChars?: number;
}

export function initialS2sUserTranscriptBuffer(): S2sUserTranscriptBuffer {
  return { text: null, stale: false };
}

function joinSegmentTexts(segments: readonly S2sUserTranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join(" ");
}

/**
 * Strips trailing punctuation/whitespace so a growing cumulative snapshot can be recognized as a
 * continuation of the accumulated text even when the provider revises trailing punctuation as more
 * words arrive (observed in the real six-snapshot reproduction: `"...project."` became
 * `"...project ini..."` — the period moved rather than the text staying a strict superstring).
 */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[\s.,!?;:]+$/u, "");
}

/** True when `longer` looks like a continuation of `shorter` — an exact prefix, or a prefix once `shorter`'s trailing punctuation is stripped. */
function isGrowingContinuationOf(shorter: string, longer: string): boolean {
  if (longer.startsWith(shorter)) return true;
  const stripped = stripTrailingPunctuation(shorter);
  if (stripped.length === 0) return false;
  return longer.startsWith(stripped);
}

function mostRecentSegmentAt(segments: readonly S2sUserTranscriptSegment[]): number | undefined {
  let max: number | undefined;
  for (const segment of segments) {
    if (segment.at !== undefined && (max === undefined || segment.at > max)) max = segment.at;
  }
  return max;
}

/** Builds the returned buffer from a finalized segment list, applying caps with visible eviction. */
function finalizeBuffer(
  segments: readonly S2sUserTranscriptSegment[],
  maxSegments: number,
  maxChars: number,
): S2sUserTranscriptBuffer {
  let working = segments;
  let truncated = false;

  while (working.length > maxSegments) {
    working = working.slice(1);
    truncated = true;
  }

  let text = joinSegmentTexts(working);
  while (text.length > maxChars && working.length > 1) {
    working = working.slice(1);
    text = joinSegmentTexts(working);
    truncated = true;
  }
  if (text.length > maxChars && working.length === 1) {
    // A single segment alone exceeds the cap. Drop leading (oldest) characters rather than trailing
    // ones — the most recent words are the ones most likely to matter for dispatch.
    const clipped = text.slice(text.length - maxChars);
    working = [{ ...working[0], text: clipped }];
    text = clipped;
    truncated = true;
  }

  return {
    text,
    stale: false,
    segments: working,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * A final user segment arrived. Merges into the current turn, or starts a new turn, per Slice 2/3
 * rules:
 *  - blank input is a no-op;
 *  - a stale buffer, an empty buffer, an armed barge-in boundary, or (when `options.now` is supplied)
 *    a gap over `turnGapMs` since the last segment all start a **new** turn — the incoming segment
 *    replaces everything;
 *  - otherwise the segment is merged into the current turn: replace-by-item when `itemId` matches an
 *    existing segment, idempotent no-op on an exact repeat, overlap-collapse when the incoming text is
 *    a growing (or shrinking/stale) variant of the accumulated text, else appended as a genuinely new
 *    segment (the legitimate split-VAD case).
 */
export function appendFinalUserTranscript(
  buffer: S2sUserTranscriptBuffer,
  text: string,
  options?: AppendFinalUserTranscriptOptions,
): S2sUserTranscriptBuffer {
  const trimmed = text.trim();
  if (!trimmed) return buffer;

  const now = options?.now;
  const itemId = options?.itemId;
  const turnGapMs = options?.turnGapMs ?? TURN_GAP_MS;
  const maxSegments = options?.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  const existingSegments = buffer.segments ?? [];
  const lastAt = mostRecentSegmentAt(existingSegments);
  const gapExpired = now !== undefined && lastAt !== undefined && now - lastAt > turnGapMs;

  const isNewTurn = buffer.stale || buffer.turnBoundaryArmed === true || existingSegments.length === 0 || gapExpired;

  if (isNewTurn) {
    const segment: S2sUserTranscriptSegment = {
      text: trimmed,
      ...(itemId ? { itemId } : {}),
      ...(now !== undefined ? { at: now } : {}),
    };
    return finalizeBuffer([segment], maxSegments, maxChars);
  }

  // Replace-by-item takes precedence: a known item recurring means "this item's text is refined",
  // never "a new segment arrived".
  if (itemId) {
    const matchIndex = existingSegments.findIndex((segment) => segment.itemId === itemId);
    if (matchIndex !== -1) {
      if (existingSegments[matchIndex].text === trimmed) return buffer;
      const next = existingSegments.slice();
      next[matchIndex] = { ...next[matchIndex], text: trimmed, ...(now !== undefined ? { at: now } : {}) };
      return finalizeBuffer(next, maxSegments, maxChars);
    }
  }

  const last = existingSegments[existingSegments.length - 1];
  if (last && last.text === trimmed) return buffer; // idempotent: exact repeat of the most recent segment

  const accumulated = joinSegmentTexts(existingSegments);
  if (trimmed === accumulated) return buffer; // idempotent: exact repeat of the whole turn so far

  if (isGrowingContinuationOf(accumulated, trimmed)) {
    // Cumulative-provider growth (or a per-segment provider that happens to restate the prefix):
    // the incoming snapshot supersedes everything accumulated so far. Collapsing to one segment is
    // what turns the real six-snapshot reproduction back into a single clean sentence.
    const segment: S2sUserTranscriptSegment = {
      text: trimmed,
      ...(itemId ? { itemId } : {}),
      ...(now !== undefined ? { at: now } : {}),
    };
    return finalizeBuffer([segment], maxSegments, maxChars);
  }

  if (isGrowingContinuationOf(trimmed, accumulated)) {
    // Incoming is a stale/shorter resend of what we already have — keep the longer text, drop this one.
    return buffer;
  }

  // Genuinely new content with no prefix/suffix relationship to the accumulated text: the legitimate
  // split-VAD case (or a per-segment provider's next discrete item). Append as a new segment.
  const segment: S2sUserTranscriptSegment = {
    text: trimmed,
    ...(itemId ? { itemId } : {}),
    ...(now !== undefined ? { at: now } : {}),
  };
  return finalizeBuffer([...existingSegments, segment], maxSegments, maxChars);
}

/** A tool call consumed the utterance — reset to empty so the next segment starts a new turn. */
export function consumeUserTranscript(buffer: S2sUserTranscriptBuffer): S2sUserTranscriptBuffer {
  void buffer; // parameter kept for call-site symmetry with the other buffer transitions
  return initialS2sUserTranscriptBuffer();
}

/** The agent completed a full spoken reply — the next user segment is a new request. */
export function markAgentReplied(buffer: S2sUserTranscriptBuffer): S2sUserTranscriptBuffer {
  return { ...buffer, stale: true };
}

/**
 * The agent has started producing audio for this turn, but its reply has not necessarily *completed*
 * (the eager-VAD common case: the user barges in before `markAgentReplied` would ever fire). Arms the
 * turn boundary so the *next* appended user segment starts a fresh turn instead of merging with — or
 * riding along on top of — whatever the user said before the agent started talking. Unlike
 * {@link markAgentReplied}, this does not itself invalidate the current transcript: it stays
 * authoritative until superseded by that next segment.
 */
export function markAgentAudioStarted(buffer: S2sUserTranscriptBuffer): S2sUserTranscriptBuffer {
  if (buffer.stale) return buffer;
  return { ...buffer, turnBoundaryArmed: true };
}

const SOCIAL_PREFIX_TOKENS = ["oke", "ok", "okay", "sip", "siap", "baik", "thank you", "thanks", "terima kasih", "makasih"];

/**
 * ASCII + CJK sentence terminators. A leading pleasantry can end up fused into the *same* segment as
 * the real request once overlap-collapse merges a cumulative provider's growing snapshots — the real
 * six-snapshot reproduction is exactly this shape ("Oke, thank you. Sekarang suruh Nova..." collapses
 * to one segment). So the social-prefix drop has to work on *sentences* inside the merged text, not
 * only on segment boundaries.
 */
const SENTENCE_SPLIT_RE = /(?<=[.!?。!?])\s+/u;

function splitIntoSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** True when every clause of `text` (split on sentence-internal punctuation) is a pure social/pleasantry token. */
function isPureSocialText(text: string): boolean {
  const clauses = text
    .toLowerCase()
    .split(/[.,!?;。!?]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => SOCIAL_PREFIX_TOKENS.includes(clause));
}

/**
 * Drops a run of leading pure-pleasantry *sentences* from the merged text, but only when a later
 * sentence in the same turn carries actionable content — a turn that is *only* pleasantries keeps its
 * text (conservative by design, per PLAN.md Slice 3). Only the front is ever trimmed: a pleasantry
 * that trails the real request (e.g. "...jelaskan project ini. Makasih.") is left alone, and a
 * pleasantry embedded inside a larger sentence (e.g. "Bilang thank you ke Nova.") is never isolated or
 * stripped, since `isPureSocialText` only matches when the *whole* sentence is pleasantries.
 */
function dropLeadingSocialSentences(text: string): string {
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return text;

  let cut = 0;
  while (cut < sentences.length && isPureSocialText(sentences[cut])) cut++;
  if (cut === 0 || cut === sentences.length) return text;
  return sentences.slice(cut).join(" ");
}

/** The authoritative transcript for delegation: text only while fresh and non-empty, else null. */
export function authoritativeUserTranscript(buffer: S2sUserTranscriptBuffer): string | null {
  if (buffer.stale) return null;
  const segments = buffer.segments;
  if (!segments || segments.length === 0) return buffer.text;
  const joined = joinSegmentTexts(segments);
  const filtered = dropLeadingSocialSentences(joined);
  return filtered.length > 0 ? filtered : null;
}
