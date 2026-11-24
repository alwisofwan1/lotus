export interface DelegationFidelityFact {
  /** Stable metric key used by reports and checkpoint comparisons. */
  id: string;
  /** Human-readable description for diagnostics and eval output. */
  label: string;
  /**
   * Every outer group must match. Phrases inside one group are equivalent alternatives, allowing a
   * preserved requirement to be expressed in the source language or a known translation.
   */
  allOf: readonly (readonly string[])[];
}

export interface DelegationFidelityInput {
  /** Final user transcript: the authority for which facts are legitimate requirements. */
  transcript: string;
  /** Exact text delivered to the worker agent. */
  deliveredText: string;
  requiredFacts: readonly DelegationFidelityFact[];
}

export interface DelegationFidelityReport {
  /** Fact ids whose definitions do not occur in the source transcript and therefore cannot be scored. */
  invalid: string[];
  /** Valid fact ids retained in the worker payload. */
  covered: string[];
  /** Valid fact ids lost from the worker payload. */
  missing: string[];
  /** Covered valid facts divided by all valid facts. */
  score: number;
  complete: boolean;
}

/** Case/width/whitespace-insensitive form used for every phrase comparison in this module. */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

const normalized = normalizeForMatch;

const TOKEN_CHARACTER = /[\p{L}\p{N}_]/u;

function isTokenCharacter(value: string | undefined): boolean {
  return value !== undefined && TOKEN_CHARACTER.test(value);
}

/**
 * Token-boundary-aware substring test. Both arguments must already be normalized
 * ({@link normalizeForMatch}). Shared with the runtime compose guard
 * (`voice-dispatch-fidelity-guard.ts`) so an offline eval and the live guard agree on what "the
 * delivered text still contains this" means — one matcher, not two drifting ones.
 */
export function includesPhrase(haystack: string, needle: string): boolean {
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index < 0) return false;
    const startsOnBoundary =
      !isTokenCharacter(needle[0]) || index === 0 || !isTokenCharacter(haystack[index - 1]);
    const endIndex = index + needle.length;
    const endsOnBoundary =
      !isTokenCharacter(needle[needle.length - 1]) ||
      endIndex === haystack.length ||
      !isTokenCharacter(haystack[endIndex]);
    if (startsOnBoundary && endsOnBoundary) return true;
    fromIndex = index + 1;
  }
  return false;
}

function matchesFact(text: string, fact: DelegationFidelityFact): boolean {
  const haystack = normalized(text);
  return fact.allOf.length > 0 && fact.allOf.every((alternatives) =>
    alternatives.some((phrase) => {
      const needle = normalized(phrase);
      return needle.length > 0 && includesPhrase(haystack, needle);
    }),
  );
}

/**
 * Deterministically score how much explicit user intent survives delegation. This baseline evaluator
 * deliberately uses exact phrases plus caller-supplied known aliases instead of an LLM judge, making
 * names, paths, numbers, negations, and output contracts reproducible in tests.
 */
export function evaluateDelegationFidelity(input: DelegationFidelityInput): DelegationFidelityReport {
  const seenIds = new Set<string>();
  for (const fact of input.requiredFacts) {
    if (seenIds.has(fact.id)) throw new Error(`Duplicate delegation fidelity fact id: ${fact.id}`);
    seenIds.add(fact.id);
  }

  const invalid: string[] = [];
  const covered: string[] = [];
  const missing: string[] = [];

  for (const fact of input.requiredFacts) {
    if (!matchesFact(input.transcript, fact)) {
      invalid.push(fact.id);
      continue;
    }
    if (matchesFact(input.deliveredText, fact)) covered.push(fact.id);
    else missing.push(fact.id);
  }

  const scoredCount = covered.length + missing.length;
  const score = scoredCount === 0 ? 1 : covered.length / scoredCount;
  return { invalid, covered, missing, score, complete: invalid.length === 0 && missing.length === 0 };
}
