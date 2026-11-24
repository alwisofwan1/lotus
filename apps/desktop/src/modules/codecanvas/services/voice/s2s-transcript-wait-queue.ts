export const S2S_TRANSCRIPT_INITIAL_WAIT_MS = 900;
export const S2S_TRANSCRIPT_PROGRESS_EXTENSION_MS = 400;
export const S2S_TRANSCRIPT_MAX_WAIT_MS = 1_500;

interface PendingTranscriptWait {
  startedAtMs: number;
  deadlineMs: number;
  timer?: ReturnType<typeof setTimeout>;
  settle: (text: string | null) => void;
}

export interface S2sTranscriptWaitQueue {
  wait: () => Promise<string | null>;
  noteProgress: () => void;
  resolveFinal: (text: string | null) => void;
  reset: () => void;
}

export interface S2sTranscriptWaitQueueDeps {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Adaptive wait for the provider race where a tool call arrives before final STT text. No transcript
 * activity gets a short deadline; partial transcription extends that deadline up to a hard cap.
 */
export function createS2sTranscriptWaitQueue(
  deps: S2sTranscriptWaitQueueDeps = {},
): S2sTranscriptWaitQueue {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const pending = new Set<PendingTranscriptWait>();

  const wait = (): Promise<string | null> => new Promise((resolve) => {
    const startedAtMs = now();
    let settled = false;
    const waiter: PendingTranscriptWait = {
      startedAtMs,
      deadlineMs: startedAtMs + S2S_TRANSCRIPT_INITIAL_WAIT_MS,
      settle(text) {
        if (settled) return;
        settled = true;
        if (waiter.timer !== undefined) clearTimer(waiter.timer);
        pending.delete(waiter);
        resolve(text);
      },
    };
    waiter.timer = setTimer(
      () => waiter.settle(null),
      Math.max(0, waiter.deadlineMs - now()),
    );
    pending.add(waiter);
  });

  return {
    wait,

    noteProgress() {
      const progressAtMs = now();
      for (const waiter of pending) {
        const hardDeadlineMs = waiter.startedAtMs + S2S_TRANSCRIPT_MAX_WAIT_MS;
        const nextDeadlineMs = Math.min(
          hardDeadlineMs,
          progressAtMs + S2S_TRANSCRIPT_PROGRESS_EXTENSION_MS,
        );
        if (nextDeadlineMs <= waiter.deadlineMs) continue;
        if (waiter.timer !== undefined) clearTimer(waiter.timer);
        waiter.deadlineMs = nextDeadlineMs;
        waiter.timer = setTimer(
          () => waiter.settle(null),
          Math.max(0, nextDeadlineMs - now()),
        );
      }
    },

    resolveFinal(text) {
      for (const waiter of [...pending]) waiter.settle(text);
    },

    reset() {
      for (const waiter of [...pending]) waiter.settle(null);
    },
  };
}
