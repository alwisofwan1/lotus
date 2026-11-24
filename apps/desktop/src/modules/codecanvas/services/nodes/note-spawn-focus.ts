/**
 * "Was this note just created?" — the one bit a fresh NoteNode needs to decide whether to take
 * the caret on mount.
 *
 * Every note is created in order to be typed in, so a brand-new note should open in edit mode
 * with the caret already blinking. A note *restored from a snapshot* must not: hydrating a canvas
 * with four empty notes would otherwise fight over the keyboard.
 *
 * Deliberately a TTL stamp and NOT a consume-once set: React StrictMode mounts a component twice
 * in dev, and a consume-once registry would hand the caret to the throwaway first mount and leave
 * the surviving one blank. A short window is idempotent, so both mounts agree.
 */

/** How long after creation a note still counts as "just spawned". */
export const NOTE_SPAWN_FOCUS_TTL_MS = 2_000;

const spawned = new Map<string, number>();

function prune(now: number): void {
  for (const [id, at] of spawned) {
    if (now - at > NOTE_SPAWN_FOCUS_TTL_MS) spawned.delete(id);
  }
}

/** Record that `id` was created by a user action right now. */
export function markNoteSpawned(id: string, now: number = Date.now()): void {
  prune(now);
  spawned.set(id, now);
}

/** True while `id` is inside the spawn window — i.e. this mount may take the caret. */
export function wasNoteJustSpawned(id: string, now: number = Date.now()): boolean {
  const at = spawned.get(id);
  return at !== undefined && now - at <= NOTE_SPAWN_FOCUS_TTL_MS;
}

/** Test seam only. */
export function resetNoteSpawnFocus(): void {
  spawned.clear();
}
