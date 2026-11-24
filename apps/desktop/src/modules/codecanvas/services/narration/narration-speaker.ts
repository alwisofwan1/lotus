/**
 * Serial discipline for the narration speaker.
 *
 * **Why the timer approach failed.** The first version gated on a fixed 2.5s gap measured from the
 * moment it *decided* to speak. That has no relationship to how long a sentence actually takes: a
 * composed intent line runs three to four seconds, so the next line arrived while the previous was
 * still playing. Cloud TTS is latest-wins, so it aborted mid-word. That is the stutter.
 *
 * Worse, composition sits between the decision and the sound. Stamping the clock at decision time
 * meant two compositions could run concurrently and resolve together, landing two utterances at
 * once — the collision.
 *
 * **The fix is to stop guessing.** `provider.speak()` already resolves when playback ends
 * (`utterance.onend` / `audio.onended`), so the true signal exists; it was simply being discarded.
 * One utterance is in flight at a time, the slot is held across composition *and* playback, and
 * everything offered meanwhile coalesces into the next one.
 */

export interface NarrationSpeakerOptions {
  /** Speak, resolving when playback actually ends. */
  speak: (text: string) => Promise<void>;
  /** Turn a coalesced batch into one line, or `null` to say nothing. */
  compose: (parts: readonly string[]) => Promise<string | null>;
  /** A beat after playback before the next line, so two updates do not run together. */
  breathMs?: number;
  /** Injectable for tests. */
  wait?: (ms: number) => Promise<void>;
}

export interface NarrationSpeaker {
  /**
   * Offer lines. Merged into the next utterance if one is already in flight.
   *
   * `alreadyComposed` marks a finished sentence — a digest from `summarizeFlush`, say. Those are
   * queued separately and spoken verbatim: they carry counts, and the narration policy insists
   * numbers survive a rewrite.
   */
  offer(parts: readonly string[], opts?: { alreadyComposed?: boolean }): void;
  /** Speak the pending batch if the slot is free. Safe to call on a tick. */
  pump(): Promise<void>;
  speaking(): boolean;
  pendingCount(): number;
  /** Discard what is queued — used when narration must go quiet. */
  clear(): void;
}

const DEFAULT_BREATH_MS = 400;

export function createNarrationSpeaker({
  speak,
  compose,
  breathMs = DEFAULT_BREATH_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: NarrationSpeakerOptions): NarrationSpeaker {
  /** Each entry is one utterance-to-be: raw steps to compose, or a finished line to say as-is. */
  type Queued = { parts: string[]; alreadyComposed: boolean };
  let queue: Queued[] = [];
  let busy = false;
  let lastSpoken: string | null = null;

  const openBatch = (): Queued | null => {
    const tail = queue[queue.length - 1];
    return tail && !tail.alreadyComposed ? tail : null;
  };

  return {
    offer(parts, opts) {
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // A repeated step yields the same phrase; saying it twice reads as a stutter, not as news.
        if (trimmed === lastSpoken) continue;
        if (opts?.alreadyComposed) {
          queue.push({ parts: [trimmed], alreadyComposed: true });
          continue;
        }
        const batch = openBatch();
        if (batch) {
          if (batch.parts[batch.parts.length - 1] === trimmed) continue;
          batch.parts.push(trimmed);
        } else {
          queue.push({ parts: [trimmed], alreadyComposed: false });
        }
      }
    },

    async pump() {
      // The slot is claimed BEFORE composition, not after: composition takes seconds, and claiming
      // it late is what let two of them resolve together.
      if (busy || queue.length === 0) return;
      busy = true;
      const batch = queue.shift()!;
      try {
        const line = batch.alreadyComposed ? batch.parts.join(", ") : await compose(batch.parts);
        if (line) {
          lastSpoken = line;
          await speak(line);
          if (breathMs > 0) await wait(breathMs);
        }
      } catch {
        // A failed synthesis must release the slot, or narration goes permanently silent.
      } finally {
        busy = false;
      }
    },

    speaking() {
      return busy;
    },

    pendingCount() {
      return queue.reduce((total, batch) => total + batch.parts.length, 0);
    },

    clear() {
      queue = [];
    },
  };
}
