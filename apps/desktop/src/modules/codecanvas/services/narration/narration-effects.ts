/**
 * Layer 6 of the narration stack: one routing decision → both output channels (Slice 6 of
 * `plans/voice-narration-layer/`).
 *
 * Heard is blind — audio is its only surface. Lotus has a canvas, so the same decision drives two
 * renderers: what gets said, and what the board shows. That is the reason the router returns a
 * decision object instead of calling `speak()` inline.
 *
 * This module is the pure half: decision + event in, a description of the effects out. The thin
 * applier that actually calls `announce()` and the focus command sits above it, so the mapping
 * itself stays exhaustively testable.
 */

import type { NarrationEvent } from "./narration-event";
import { isPierceTag, type RoutingDecision } from "./narration-router";

export interface NarrationEffects {
  /**
   * Whether this event should be spoken at all. Deliberately NOT the text: composing the line is
   * Layer 5's job, and having this module emit `neutral` verbatim is exactly the defect that made
   * narration read out file paths and whole assistant replies.
   */
  shouldSpeak: boolean;
  /** `"Nova: "` when the listener needs telling who is talking; empty otherwise. */
  labelPrefix: string;
  /** Node to point the camera at, or `null` to leave the viewport alone. */
  focusNodeId: string | null;
  /** Held back for a later digest — the board shows activity, the speaker stays quiet. */
  pending: boolean;
}

const NOTHING: NarrationEffects = { shouldSpeak: false, labelPrefix: "", focusNodeId: null, pending: false };

/** `canvas:projA:node-9` → `node-9`; an unscoped id is already the node id. */
function nodeIdOf(paneId: string): string {
  const scoped = /^canvas:[^:]+:(.+)$/.exec(paneId);
  return scoped?.[1] ?? paneId;
}

/**
 * Map a routing decision onto what the user should hear and see.
 *
 * A pierce earns a camera move; routine work does not. Yanking the viewport on every tool call
 * would make the canvas unusable, and the whole value of the second channel is that it can show
 * activity *without* demanding attention.
 */
export function narrationEffectsFor(decision: RoutingDecision, event: NarrationEvent): NarrationEffects {
  if (decision.action === "drop") return NOTHING;
  if (decision.action === "defer_to_digest")
    return { shouldSpeak: false, labelPrefix: "", focusNodeId: null, pending: true };

  // Read urgency from the TAG, not from whether a name was attached: with one agent working the
  // router speaks a failure with no prefix, so a prefix-based check would never focus the camera
  // in the single-agent case.
  const pierced = isPierceTag(event.tag);

  return {
    shouldSpeak: true,
    labelPrefix: decision.labelPrefix,
    // Nothing to say is not a reason to stop pointing at the agent that needs a human.
    focusNodeId: pierced ? nodeIdOf(event.paneId) : null,
    pending: false,
  };
}
