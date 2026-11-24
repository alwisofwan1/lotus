/**
 * Auto-naming core for spawn-first agents (ADR-0026 §NP.2 / PLAN §3.5).
 *
 * In the CNVS model, "creating an agent" is a side-effect of spawning a CLI, not an
 * authoring step. This leaf seam supplies the lightweight coordination *handle*: a curated
 * pool of botanical names from which the next per-canvas-unique handle is drawn. The handle is
 * decoupled from the persona (role/model/prompt) and from the CLI — it is just a display name.
 * Addressing elsewhere stays id-backed (NP.4), so a name only ever needs to be unique enough to
 * resolve `target:"Sage"` → id without ambiguity, and to read cleanly in a header.
 *
 * Pure TypeScript leaf (like `src/lib/agent-runtime/`): no React, no `@/modules/**`, and
 * deterministic — no `Math.random()` / `Date.now()`, so the same `taken` set always yields the
 * same next name.
 */

/**
 * Curated agent handles, locale-aware for voice-first interaction.
 *
 * Naming is not cosmetic here: a user addresses an agent out loud ("Kai, run the tests"), STT
 * transcribes it, and the NL layer matches that transcript to a node by name. A handle that is hard
 * for the user to pronounce or for STT to transcribe in their language becomes a mismatch — the
 * command silently misfires. So each pool is tuned to be easy to *say* and *transcribe* for its
 * locale, minimizing dictionary-word collisions (which used to force NL special-casing) while staying
 * short, neutral, and readable in a node header. Order is meaningful: {@link nextAgentName} assigns
 * them in sequence. The theme is swappable — callers pass a locale-resolved pool via
 * {@link resolveNamePool} (or any custom roster) — this file just ships the curated defaults.
 */

/** Default roster: neutral, modern, globally pronounceable. Used for `en`/unknown locales. */
export const UNIVERSAL_AGENT_NAME_POOL: readonly string[] = [
  "Atlas",
  "Nova",
  "Kai",
  "Juno",
  "Orion",
  "Vega",
  "Lyra",
  "Milo",
  "Ezra",
  "Nia",
  "Remy",
  "Soren",
  "Cleo",
  "Dara",
  "Faye",
  "Gio",
  "Hana",
  "Ivo",
  "Tao",
  "Zia",
];

/** Japanese-friendly: short open-syllable given names, unambiguous in kana and romaji for STT. */
export const JA_AGENT_NAME_POOL: readonly string[] = [
  "Rin",
  "Ren",
  "Sora",
  "Kai",
  "Yui",
  "Aoi",
  "Rei",
  "Nao",
  "Riku",
  "Haru",
  "Mio",
  "Kaito",
  "Yuki",
  "Hana",
  "Ami",
  "Sana",
  "Rui",
  "Nami",
  "Emi",
  "Taro",
];

/** Indonesian-friendly: vowel-clear, easy to pronounce and transcribe for Indonesian speakers. */
export const ID_AGENT_NAME_POOL: readonly string[] = [
  "Nara",
  "Bima",
  "Sena",
  "Bayu",
  "Aji",
  "Galih",
  "Wira",
  "Indra",
  "Reza",
  "Fajar",
  "Rangga",
  "Cahya",
  "Dian",
  "Rani",
  "Tari",
  "Ayu",
  "Nita",
  "Sari",
  "Dewi",
  "Lala",
];

/**
 * The default roster {@link nextAgentName} / {@link uniqueAgentName} fall back to when no pool is
 * passed. Neutral/modern (the universal pool) — locale personalization is opt-in via
 * {@link resolveNamePool}, so the zero-config default stays stable and deterministic for tests.
 */
export const DEFAULT_AGENT_NAME_POOL: readonly string[] = UNIVERSAL_AGENT_NAME_POOL;

/** Locale primary-subtag → curated pool. Extend here to add a new locale roster. */
const POOLS_BY_LOCALE: Readonly<Record<string, readonly string[]>> = {
  en: UNIVERSAL_AGENT_NAME_POOL,
  ja: JA_AGENT_NAME_POOL,
  id: ID_AGENT_NAME_POOL,
};

/**
 * Resolves a BCP-47-ish locale string (e.g. "ja", "ja-JP", "id_ID", navigator.language) to the
 * curated pool for that language, falling back to {@link DEFAULT_AGENT_NAME_POOL} for an unknown,
 * empty, or missing locale. Matches on the primary subtag only, case- and separator-insensitive.
 *
 * Pure: the caller decides the locale (an explicit user setting, or navigator.language for "auto")
 * and passes it in — this leaf never touches the DOM, so it stays testable and deterministic.
 */
export function resolveNamePool(locale?: string | null): readonly string[] {
  const primary = (locale ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return POOLS_BY_LOCALE[primary] ?? DEFAULT_AGENT_NAME_POOL;
}

/**
 * Canonical form for handle comparison: trim + lowercase. MUST stay in lockstep with
 * `resolveAgentByName` in `src/modules/codecanvas/services/canvas-nl-command.ts`, which compares
 * `name.trim().toLowerCase()`. Uniqueness and collision checks here are all defined in these terms.
 */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Picks the next unused handle for a freshly spawned agent.
 *
 * Returns the first {@link pool} entry whose normalized form is not present in `taken` (compared
 * normalized). When every pool entry is taken, falls back to `Agent N`, choosing the smallest
 * positive integer `N` whose normalized name is unused. Never throws and never returns a name that
 * collides with `taken`.
 *
 * @param taken normalized-or-raw handles already in use on the canvas (compared via {@link normalizeName})
 * @param pool  optional override roster; defaults to {@link DEFAULT_AGENT_NAME_POOL}
 */
export function nextAgentName(
  taken: Iterable<string>,
  pool: readonly string[] = DEFAULT_AGENT_NAME_POOL,
): string {
  const used = new Set<string>();
  for (const name of taken) used.add(normalizeName(name));

  for (const candidate of pool) {
    if (!used.has(normalizeName(candidate))) return candidate;
  }

  // Pool exhausted — fall back to the smallest unused "Agent N".
  for (let n = 1; ; n++) {
    const candidate = `Agent ${n}`;
    if (!used.has(normalizeName(candidate))) return candidate;
  }
}

/**
 * Returns a canvas-unique handle: keeps `desired` when it's non-empty and not already taken,
 * otherwise falls back to {@link nextAgentName} (next free pool entry, then `Agent N`). Use this at
 * node-creation time — including same-tick batch spawns — so two agents never share a display name
 * (which would make `target:"Rowan"` dispatch ambiguous). Compared via {@link normalizeName}.
 *
 * @param pool optional locale-resolved roster for the fallback path; defaults to
 *   {@link DEFAULT_AGENT_NAME_POOL}. A non-empty `desired` is always honored regardless of pool.
 */
export function uniqueAgentName(
  desired: string,
  taken: Iterable<string>,
  pool: readonly string[] = DEFAULT_AGENT_NAME_POOL,
): string {
  const takenArr = Array.from(taken);
  const used = new Set(takenArr.map(normalizeName));
  const trimmed = desired.trim();
  if (trimmed && !used.has(normalizeName(trimmed))) return trimmed;
  return nextAgentName(takenArr, pool);
}

/** Outcome of {@link validateAgentName}: ok, or a single clearest reason for rejection. */
export type NameValidation =
  | { ok: true }
  | { ok: false; reason: "empty" | "duplicate" | "too-long" | "invalid-char" };

const MAX_NAME_LENGTH = 32;
/** Letters, digits, space, hyphen, underscore. Applied to the trimmed name. */
const ALLOWED_NAME_PATTERN = /^[\p{L}\p{N} _-]+$/u;

/**
 * Validates a user-supplied handle for the rename path (NP.5).
 *
 * Checks, in order of clearest reason first: empty → invalid-char → too-long → duplicate. The
 * length and character checks apply to the trimmed name; duplicate uses {@link normalizeName}.
 *
 * Note: `taken` may include the agent's *own* current handle during a rename. That is the caller's
 * concern — this function only checks membership, so the caller should exclude the current name
 * from `taken` before validating (otherwise an unchanged name reports `duplicate`).
 */
export function validateAgentName(name: string, taken: Iterable<string>): NameValidation {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (!ALLOWED_NAME_PATTERN.test(trimmed)) return { ok: false, reason: "invalid-char" };
  if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, reason: "too-long" };

  const normalized = normalizeName(trimmed);
  for (const existing of taken) {
    if (normalizeName(existing) === normalized) return { ok: false, reason: "duplicate" };
  }
  return { ok: true };
}
