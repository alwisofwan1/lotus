/**
 * Freshness gate for narration events (Slice 3 of `plans/voice-narration-layer/`).
 *
 * **Why this exists, and why it is not a content-hash dedup.** Heard needed `spoken.py` — a hash
 * set plus a transcript byte offset seeded at EOF — because it re-read a growing transcript file on
 * every hook and would otherwise replay the whole backlog. Our source is different: drop files are
 * consumed and unlinked by the Rust watcher, so the same drop is never delivered twice and there is
 * no observed duplicate-content problem to solve.
 *
 * The hazard our source *does* have is the startup drain: `drop_dir.rs` emits every unprocessed
 * drop whose mtime is inside `DEFAULT_DRAIN_TTL` (5 minutes). A busy agent leaves dozens behind, so
 * opening the app would narrate minutes of history in the present tense. This module is the answer
 * to that, and only that. If duplicate content is ever actually observed, a hash set can be added
 * then — on evidence.
 */

import type { NarrationEvent } from "./narration-event";

/**
 * How old an event may be and still be worth speaking.
 *
 * Narration is about what is happening now — "I'm editing the auth flow" is a lie thirty seconds
 * later. Kept well inside the drainer's 5-minute TTL so the gate actually bites; a window at or
 * past that TTL would let the whole drained backlog through and make this a no-op.
 */
export const NARRATION_MAX_AGE_MS = 20_000;

/**
 * Whether an event is recent enough to narrate. A timestamp in the future counts as fresh: clock
 * skew between the hook process and the renderer is real, and silencing a live event over it would
 * be the worse failure.
 */
export function isFreshNarration(event: NarrationEvent, now: number): boolean {
  return now - event.ts <= NARRATION_MAX_AGE_MS;
}
