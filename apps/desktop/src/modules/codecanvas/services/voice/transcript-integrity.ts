export type TranscriptIntegrityQuality = "clean" | "degraded";

/** Machine-readable reason codes explaining why a transcript was degraded. */
export type TranscriptIntegrityReason = "repetition" | "disproportionate";

export interface TranscriptIntegrityInput {
  /** Candidate transcript to score — typically the accumulated `sourceTranscript` before delegation. */
  transcript: string;
  /** Optional short-form objective the transcript is meant to back up; drives the length-disproportion check. */
  objective?: string;
}

export interface TranscriptIntegrityMetrics {
  /** Fraction (0..1) of word n-grams that recur elsewhere in the transcript. */
  repeatedNGramRatio: number;
  /** Fraction (0..1) of sentence-like segments that are a word-prefix of (or identical to) another segment. */
  repeatedPrefixRatio: number;
  /** Transcript length in characters divided by objective length in characters; 0 when not applicable. */
  lengthRatio: number;
}

export interface TranscriptIntegrityVerdict {
  quality: TranscriptIntegrityQuality;
  /** Why `quality` is "degraded"; empty when clean. */
  reasons: TranscriptIntegrityReason[];
  metrics: TranscriptIntegrityMetrics;
}

/**
 * Word n-gram size used for the repetition scan. 3 catches repeated phrases (e.g. "sekarang suruh
 * nova" recurring across accumulator snapshots) while deliberately letting a legitimately reused bigram
 * through — "hapus file" repeating across "hapus file A, hapus file B, hapus file C" never forms a
 * repeated trigram because the third word differs every time.
 */
export const TRANSCRIPT_INTEGRITY_NGRAM_SIZE = 3;

/** `repeatedNGramRatio` at or above this ratio is treated as corrupted repetition. */
export const TRANSCRIPT_INTEGRITY_NGRAM_RATIO_THRESHOLD = 0.4;

/** `repeatedPrefixRatio` at or above this ratio is treated as corrupted growing-prefix duplication. */
export const TRANSCRIPT_INTEGRITY_PREFIX_RATIO_THRESHOLD = 0.34;

/**
 * `lengthRatio` at or above this multiple (combined with the minimums below) flags a bloated verbatim
 * block riding behind a short, correctly-grounded objective.
 */
export const TRANSCRIPT_INTEGRITY_LENGTH_RATIO_THRESHOLD = 6;

/** Minimum transcript length (chars) before the length-disproportion check is meaningful at all. */
export const TRANSCRIPT_INTEGRITY_MIN_TRANSCRIPT_LENGTH = 40;

/** Minimum objective length (chars) required before dividing by it — guards a near-empty objective. */
export const TRANSCRIPT_INTEGRITY_MIN_OBJECTIVE_LENGTH = 3;

function normalizeForScoring(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/** Matches runs of letters/digits in any script — CJK runs with no internal spacing collapse to one token. */
const WORD_RE = /[\p{L}\p{N}]+/gu;

function wordsOf(text: string): string[] {
  return normalizeForScoring(text).match(WORD_RE) ?? [];
}

function repeatedNGramRatio(words: string[]): number {
  const n = TRANSCRIPT_INTEGRITY_NGRAM_SIZE;
  if (words.length < n) return 0;

  const counts = new Map<string, number>();
  const grams: string[] = [];
  for (let index = 0; index <= words.length - n; index++) {
    const gram = words.slice(index, index + n).join(" ");
    grams.push(gram);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  const repeated = grams.filter((gram) => (counts.get(gram) ?? 0) > 1).length;
  return repeated / grams.length;
}

/** Splits on sentence-ending punctuation (ASCII + common CJK terminators) followed by whitespace. */
const SENTENCE_BOUNDARY_RE = /(?<=[.!?。！？])\s+/u;

function segmentsOf(text: string): string[] {
  return normalizeForScoring(text)
    .split(SENTENCE_BOUNDARY_RE)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** True when every word of `shorter` matches the corresponding word of `longer`, in order. */
function isWordPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  return shorter.every((word, index) => word === longer[index]);
}

function repeatedPrefixRatio(segments: string[]): number {
  if (segments.length < 2) return 0;

  const tokenized = segments.map((segment) => segment.match(WORD_RE) ?? []);
  const involved = new Array(segments.length).fill(false) as boolean[];

  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const a = tokenized[i];
      const b = tokenized[j];
      const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
      if (isWordPrefix(shorter, longer)) {
        involved[i] = true;
        involved[j] = true;
      }
    }
  }

  return involved.filter(Boolean).length / segments.length;
}

function computeLengthRatio(transcript: string, objective: string | undefined): number {
  const transcriptLength = transcript.trim().length;
  const objectiveLength = (objective ?? "").trim().length;
  if (objectiveLength < TRANSCRIPT_INTEGRITY_MIN_OBJECTIVE_LENGTH) return 0;
  if (transcriptLength < TRANSCRIPT_INTEGRITY_MIN_TRANSCRIPT_LENGTH) return 0;
  return transcriptLength / objectiveLength;
}

/**
 * Pure corruption scan over a candidate transcript, run before it is trusted as an "authoritative,
 * verbatim" worker payload. Catches the accumulator-duplication shape (repeated words and repeated
 * growing-prefix segments — see plans/voice-dispatch-payload-integrity/PLAN.md §2.1) and a bloated
 * verbatim block riding behind a short, correctly-grounded objective. Never mutates or truncates the
 * transcript; callers decide how to degrade rendering.
 */
export function scoreTranscriptIntegrity(input: TranscriptIntegrityInput): TranscriptIntegrityVerdict {
  const transcript = input.transcript ?? "";
  const words = wordsOf(transcript);
  const segments = segmentsOf(transcript);

  const metrics: TranscriptIntegrityMetrics = {
    repeatedNGramRatio: repeatedNGramRatio(words),
    repeatedPrefixRatio: repeatedPrefixRatio(segments),
    lengthRatio: computeLengthRatio(transcript, input.objective),
  };

  const reasons: TranscriptIntegrityReason[] = [];
  if (
    metrics.repeatedNGramRatio >= TRANSCRIPT_INTEGRITY_NGRAM_RATIO_THRESHOLD ||
    metrics.repeatedPrefixRatio >= TRANSCRIPT_INTEGRITY_PREFIX_RATIO_THRESHOLD
  ) {
    reasons.push("repetition");
  }
  if (metrics.lengthRatio >= TRANSCRIPT_INTEGRITY_LENGTH_RATIO_THRESHOLD) {
    reasons.push("disproportionate");
  }

  return { quality: reasons.length > 0 ? "degraded" : "clean", reasons, metrics };
}
