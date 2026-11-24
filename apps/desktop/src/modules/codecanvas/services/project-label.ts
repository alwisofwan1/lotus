/**
 * The project chip in the NL command bar (CanvasProjectMenu) used tail-ellipsis at a 15rem cap,
 * which for a real slug like "orchids-claude-agent-teams" renders "orchids-claude-ag…" — the half
 * of the name that identifies nothing gets to stay, and the half that does gets cut. This trims
 * from the HEAD instead, keeping the informative tail behind a leading "…".
 *
 * The cut is segment-aware (split on "-") so it always lands right after a separator: the tail is
 * built by walking segments from the end and stopping as soon as one more whole segment would blow
 * the budget, never a mid-word slice that could read like "…-claude-agent-teams" (a stray leading
 * separator, which reads as noise rather than the start of a word).
 */

const SEGMENT_SEPARATOR = "-";
const ELLIPSIS = "…";

export function headTrimProjectName(name: string, max = 20): string {
  if (name.length <= max) return name;

  // Reserve one slot for the leading ellipsis so the final string never exceeds `max`.
  const budget = max - ELLIPSIS.length;
  const segments = name.split(SEGMENT_SEPARATOR);

  if (segments.length <= 1) {
    // No "-" to align a cut to (e.g. a camelCase or single-word slug) — fall back to a plain
    // tail slice. Still respects `max`; just can't guarantee a semantic boundary.
    return `${ELLIPSIS}${name.slice(Math.max(0, name.length - budget))}`;
  }

  // Walk segments from the end, growing the tail one whole segment at a time, and stop the
  // instant the next segment would overrun the budget. This guarantees the character right
  // after the ellipsis is always the first character of a segment, never a "-".
  let tail = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = tail ? `${segments[i]}${SEGMENT_SEPARATOR}${tail}` : segments[i];
    if (candidate.length > budget) break;
    tail = candidate;
  }

  if (!tail) {
    // Even the last segment alone overruns the budget (one very long final segment) — fall
    // back to a plain slice of it so the result still respects `max`.
    const last = segments[segments.length - 1];
    return `${ELLIPSIS}${last.slice(Math.max(0, last.length - budget))}`;
  }

  return `${ELLIPSIS}${tail}`;
}
