/**
 * Pragmatic runner-name resolution for voice/NL (no imports from the NL layer — keep it cycle-free).
 *
 * Voice transcription mangles proper nouns ("acme" heard as "Weasley") and users say fuzzy synonyms
 * ("cloud agent"). Rather than reject, we (1) map common aliases to a concrete runner, then (2) fuzzy-
 * match a near-miss token to the closest known runner name by edit distance. This turns a hard "doesn't
 * match / please clarify" into a helpful best-guess spawn — the pragmatic behavior for a voice-first bar.
 */

/** Common spoken synonyms → a concrete runner token. Extend as real usage surfaces more. */
export const RUNNER_ALIASES: Record<string, string> = {
  cloud: "claude",
  "cloud agent": "claude",
  "cloud code": "claude",
  anthropic: "claude",
  openai: "codex",
  gpt: "codex",
};

/** Resolve a spoken alias to its runner token, or null. Case/space-insensitive. */
export function resolveRunnerAlias(token: string): string | null {
  const key = token.trim().toLowerCase().replace(/\s+/g, " ");
  return RUNNER_ALIASES[key] ?? null;
}

/** Levenshtein edit distance — small inputs (runner names), so the simple O(n·m) DP is fine. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Best fuzzy match for `token` among `candidates`, or null when none is close enough. The threshold
 * scales with name length (short names like "ccs" demand a near-exact match; longer names tolerate a
 * transcription slip or two) and is capped so unrelated words never match.
 */
export function fuzzyMatchName(token: string, candidates: readonly string[]): string | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  let best: { name: string; dist: number } | null = null;
  for (const candidate of candidates) {
    const c = candidate.trim().toLowerCase();
    if (!c) continue;
    const dist = levenshtein(t, c);
    // Allow up to ~1/3 of the longer name's length, capped at 2 — enough for a voice slip, tight
    // enough that "focus" never becomes "codex".
    const threshold = Math.min(2, Math.floor(Math.max(t.length, c.length) / 3));
    if (dist <= threshold && (best === null || dist < best.dist)) {
      best = { name: candidate, dist };
    }
  }
  return best?.name ?? null;
}
