/**
 * Runtime fidelity guard for the voice → agent prompt rewrite.
 *
 * `voice-dispatch-compose.ts` asks a fast model to clean up dictated speech. Cleanup is safe;
 * *editing* is not. This module is the deterministic check that decides whether what came back is
 * still the user's request — the runtime sibling of `delegation-fidelity.ts` (which scores the same
 * property offline, against hand-written fact lists, in tests).
 *
 * A word-count ratio alone cannot see the failures that actually matter, because the dangerous ones
 * preserve length:
 *   • detail loss   — "restart the server on port 3000" → "restart the server";
 *   • negation loss — "review it but don't change anything" → "review and fix it";
 *   • invention     — the model answers, plans, or appends acceptance criteria nobody asked for.
 *
 * So the guard checks three independent things: critical tokens survived, the negation class
 * survived, and the length stayed inside the band real cleanup produces. Any failure means the
 * composition is discarded and the caller falls back to the locally de-framed transcript —
 * fidelity outranks polish, always.
 *
 * Every rule here is intentionally conservative in the same direction: a false rejection costs
 * polish (the user gets their raw words, which are still correct), while a false acceptance costs
 * meaning. Only the first is acceptable.
 */

import { includesPhrase, normalizeForMatch } from "./delegation-fidelity";

/**
 * A composition shorter than this fraction of the spoken word count has summarised rather than
 * cleaned. Real cleanup removes fillers and false starts — it lands around 0.6–0.95 of the original,
 * never a tenth of it.
 */
export const MIN_FIDELITY_RATIO = 0.4;

/**
 * Cleanup only ever removes words; it never invents them. Comfortably above the worst legitimate
 * case (expanding dictated symbols and paths, e.g. "dash dash verbose" → "--verbose") and well below
 * a model that has started planning, answering, or appending requirements of its own.
 */
export const MAX_FIDELITY_RATIO = 1.6;

/** Below this spoken length the ratio is too noisy to judge, so the length band stays out of the way. */
export const FIDELITY_GUARD_MIN_WORDS = 12;

/**
 * A cleanup may remove fillers and tighten grammar, but it should still retain most of the speaker's
 * lexical payload. This catches a dangerous blind spot in length-only checks: an unrelated sentence
 * can have exactly the same number of words. Kept deliberately low so normal punctuation, inflection,
 * and light paraphrasing do not reject useful cleanup.
 */
export const MIN_LEXICAL_RETENTION = 0.4;

const LEXICAL_FILLERS = new Set([
  "actually", "basically", "eh", "eee", "hmm", "just", "like", "okay", "please", "so", "tolong", "uh", "um",
]);

/**
 * High-signal spans whose loss silently changes the job. Ordered most-specific first; overlapping
 * matches are deduped by the extractor.
 *
 * Bare 1-digit numbers are deliberately excluded: they are usually spoken list ordinals ("one, fix
 * the test"), and a rewrite legitimately renders them as words. Two digits and up ("3000", "1.2.4",
 * "v2") are concrete facts about the request.
 */
const CRITICAL_PATTERNS: readonly RegExp[] = [
  /`[^`\n]{1,120}`/g,
  /\bhttps?:\/\/[^\s"'`]+/gi,
  /\b[\w@][\w.@-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|rs|py|rb|go|java|kt|swift|c|h|cc|cpp|css|scss|less|html|xml|yml|yaml|toml|lock|sh|zsh|bash|sql|env|ini|conf|proto|graphql|prisma|svg|png|csv)\b/gi,
  /(?:^|[\s("'“‘])((?:\.{0,2}\/)?(?:[\w.@~-]+\/){1,}[\w.@-]+)/g,
  /(?<![\w.])(?:v\d+(?:\.\d+)*|\d+(?:\.\d+)+|\d{2,})(?![\w.])/gi,
  /--?[a-z][\w-]{1,30}\b/gi,
];

/**
 * PROHIBITION markers across the languages this app is actually spoken in — the boundaries a user
 * puts on an agent ("review it but don't change anything", "analisis saja, jangan ubah kode").
 *
 * Checked as a CLASS, not token by token: "don't change the schema" → "do not change the schema" is
 * a legitimate rewrite, whereas losing the prohibition entirely never is. Counting the class keeps
 * the guard robust to rephrasing while still catching the reversal.
 *
 * Bare hedging negation ("I'm not sure", "no idea") is deliberately excluded. It is not a boundary
 * on the agent, and a rewrite may legitimately render it without a negative word ("I'm unsure") —
 * including it would reject good compositions for no fidelity gain.
 */
const PROHIBITION_RE =
  /\b(?:don'?t|doesn'?t|won'?t|can'?t|cannot|shouldn'?t|mustn'?t|do not|must not|should not|will not|may not|never|without|avoid|refrain|instead of|rather than|jangan|tanpa|hindari|dilarang|kecuali|jangan sampai)\b/i;

export type VoiceFidelityFailure = "summary" | "expansion" | "detail-loss" | "negation-loss" | "semantic-drift";

export interface VoiceFidelityVerdict {
  /** True when the composition may be delivered as-is. */
  ok: boolean;
  /** Which invariant broke. Absent when `ok`. */
  failure?: VoiceFidelityFailure;
  /** Critical spans present in the speech but absent from the composition (for `detail-loss`). */
  dropped: string[];
  /** Composed words ÷ spoken words. Reported for diagnostics even when the verdict passes. */
  ratio: number;
}

export function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function lexicalTokens(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return new Set(tokens.filter((token) => token.length > 1 && !LEXICAL_FILLERS.has(token)));
}

function lexicalRetention(transcript: string, composed: string): number {
  const source = lexicalTokens(transcript);
  if (source.size === 0) return 1;
  const output = lexicalTokens(composed);
  let retained = 0;
  for (const token of source) {
    if (output.has(token)) retained += 1;
  }
  return retained / source.size;
}

/** Backticks are decoration the rewrite may add or drop freely; the identifier inside is the fact. */
function unquoteToken(token: string): string {
  return token.replace(/^`+|`+$/g, "").trim();
}

/**
 * Pull the spans of a transcript whose disappearance would change what the agent does. Exported for
 * tests and diagnostics; duplicates and empties are removed, order of first appearance is kept.
 */
export function extractCriticalTokens(transcript: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const pattern of CRITICAL_PATTERNS) {
    // Each pattern carries /g, so lastIndex must be reset — these are module-level singletons.
    pattern.lastIndex = 0;
    for (const match of transcript.matchAll(pattern)) {
      const raw = unquoteToken(match[1] ?? match[0]);
      if (raw.length < 2) continue;
      const key = normalizeForMatch(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tokens.push(raw);
    }
  }
  return tokens;
}

/** Critical spans the composition lost. Empty means every concrete fact survived. */
export function findDroppedCriticalTokens(transcript: string, composed: string): string[] {
  const haystack = normalizeForMatch(composed);
  return extractCriticalTokens(transcript).filter(
    (token) => !includesPhrase(haystack, normalizeForMatch(token)),
  );
}

/**
 * Decide whether a composition still faithfully carries the spoken request.
 *
 * Order is deliberate: detail loss and negation loss are checked first and at ANY length, because
 * they are the failures that survive a plausible-looking word count. The length band runs last and
 * only once the utterance is long enough for the ratio to mean anything.
 */
export function judgeVoiceComposition(transcript: string, composed: string): VoiceFidelityVerdict {
  const spokenWords = wordCount(transcript);
  const composedWords = wordCount(composed);
  const ratio = spokenWords === 0 ? 1 : composedWords / spokenWords;

  const dropped = findDroppedCriticalTokens(transcript, composed);
  if (dropped.length > 0) return { ok: false, failure: "detail-loss", dropped, ratio };

  if (PROHIBITION_RE.test(transcript) && !PROHIBITION_RE.test(composed)) {
    return { ok: false, failure: "negation-loss", dropped, ratio };
  }

  if (spokenWords >= FIDELITY_GUARD_MIN_WORDS) {
    if (ratio < MIN_FIDELITY_RATIO) return { ok: false, failure: "summary", dropped, ratio };
    if (ratio > MAX_FIDELITY_RATIO) return { ok: false, failure: "expansion", dropped, ratio };
    if (lexicalRetention(transcript, composed) < MIN_LEXICAL_RETENTION) {
      return { ok: false, failure: "semantic-drift", dropped, ratio };
    }
  }

  return { ok: true, dropped, ratio };
}
