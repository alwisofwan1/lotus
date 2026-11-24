/**
 * How hard an agent thinks: the one vocabulary, and the rules for keeping a stored value honest.
 *
 * The scale is taken from bb (`packages/domain/src/shared-types.ts`), because it matches what the
 * CLIs actually accept. Measured against the real binary on 2026-09-10:
 *
 * ```
 * $ claude --effort bogus -p "hi"
 * Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort.
 * Valid values: low, medium, high, xhigh, max.
 * ```
 *
 * Two facts follow, and both were wrong in Lotus before this file existed:
 *
 * - **`minimal` is not a level.** Lotus offered it (`agent-governance.ts`), Claude rejects it, and
 *   the rejection is a warning rather than an error — so an agent set to "minimal" ran at the
 *   default effort while the UI claimed otherwise. {@link normalizeReasoningLevel} carries those
 *   saved values to `low`.
 * - **`xhigh` is a level**, and it was never offered.
 *
 * What a given model or provider supports is NOT stated here: this union says what may exist,
 * `config/models/catalog.ts` says what applies. A provider with no effort knob at all (cursor,
 * opencode — see `agent-tuning.ts`) supports the empty list, and its UI must hide the field
 * rather than show a value that will be dropped on the way to the process.
 */

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

const DEFAULT_LEVEL: ReasoningLevel = "medium";

/** Values Lotus used to write that are not levels any more, and where they land. */
const RETIRED_LEVELS: Readonly<Record<string, ReasoningLevel>> = {
  // Claude's own scale starts at `low`; "minimal" was Lotus's invention and was ignored.
  minimal: "low",
};

function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * A stored string as a usable level. Values read from disk (team configs, agent definitions)
 * arrive here, so it must not throw on anything — an unreadable value becomes `medium`.
 */
export function normalizeReasoningLevel(value: string | null | undefined): ReasoningLevel {
  const raw = value?.trim().toLowerCase() ?? "";
  if (isReasoningLevel(raw)) return raw;
  return RETIRED_LEVELS[raw] ?? DEFAULT_LEVEL;
}

/**
 * The level to use after the model or provider changed, given what the new one supports.
 *
 * Nearest-along-the-scale rather than reset-to-default, and ties go UP: a user who asked for more
 * thinking should never silently receive less because they switched model. Same rule as bb's
 * `reconcileReasoningLevel`.
 *
 * `null` means the new target supports no effort at all — the caller hides the control.
 */
export function reconcileReasoningLevel(
  previous: ReasoningLevel,
  supported: readonly ReasoningLevel[],
): ReasoningLevel | null {
  if (supported.length === 0) return null;
  if (supported.includes(previous)) return previous;

  // `ultracode` is bb's name for an xhigh-shaped budget; try that before measuring distance.
  const effective = previous === "ultracode" ? "xhigh" : previous;
  if (supported.includes(effective)) return effective;

  const target = rank(effective);
  let best = supported[0];
  let bestDistance = Math.abs(rank(best) - target);
  for (const candidate of supported.slice(1)) {
    const distance = Math.abs(rank(candidate) - target);
    if (distance < bestDistance || (distance === bestDistance && rank(candidate) > rank(best))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function rank(level: ReasoningLevel): number {
  return REASONING_LEVELS.indexOf(level);
}
