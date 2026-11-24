/**
 * How much narration says (Slice 2 of `plans/voice-narration-layer/`).
 *
 * Distinct from the router, which decides *when* the listener can be interrupted. This decides
 * which events are worth words at all. Built after desktop testing, where the report was blunt:
 * "every single step is spoken."
 *
 * The single biggest cut is announcing a tool's start but not its successful finish. "Editing auth"
 * followed by "edited auth" is double the words for no extra information — the finish only carries
 * news when it went wrong.
 */

import type { NarrationEvent } from "./narration-event";
import { isPierceTag } from "./narration-router";

export type NarrationProfile = "quiet" | "normal" | "verbose";

/** Balanced, not loudest: `quiet` hides ordinary progress, `verbose` is a firehose. */
export const DEFAULT_NARRATION_PROFILE: NarrationProfile = "normal";

/**
 * Tools worth hearing about even in `quiet`, because they are the ones a person actually waits on.
 * A delegation or a test run can take minutes; an `Edit` takes no time at all.
 */
const MILESTONE_STEMS: ReadonlySet<string> = new Set(["task", "websearch", "webfetch"]);

function stemOf(tag: string): string {
  const parts = tag.split("_");
  return (parts[1] === "post" || parts[1] === "pre" ? parts.slice(2) : parts.slice(1)).join("_");
}

/**
 * Whether this event earns words under the given profile.
 *
 * Failures, questions and new prompts pass in EVERY profile. A verbosity setting must never be able
 * to hide a regression — that is the same invariant the router's pierce list protects, enforced
 * again here because this gate runs first.
 */
export function shouldNarrate(event: NarrationEvent, profile: NarrationProfile): boolean {
  if (isPierceTag(event.tag)) return true;
  if (event.kind === "final") return true;
  if (profile === "verbose") return true;

  // A successful finish adds nothing the start did not already say.
  if (event.kind === "tool_post") return false;
  if (profile === "quiet") return MILESTONE_STEMS.has(stemOf(event.tag));
  return true;
}
