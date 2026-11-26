export const S2S_TOOL_RESULT_FALLBACK_MS = 150;

export interface S2sToolResultItem {
  callId: string;
  output: string;
  /** The user asked for no spoken reply to this result (Live Voice assistant readback off). */
  silent?: boolean;
}

export interface S2sToolResultBatcherDeps {
  send: (result: S2sToolResultItem, continueResponse: boolean) => void | Promise<void>;
  onError?: (error: unknown) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface S2sToolResultBatcher {
  begin: (callId: string) => void;
  complete: (callId: string, output: string, silent?: boolean) => Promise<void>;
  markResponseDone: () => Promise<void>;
  reset: () => void;
}

/**
 * Correlates locally executing tool calls with the provider's `response.done` boundary. Every
 * function output is sent in order, but only the final item asks the provider to continue, avoiding
 * one competing `response.create` per parallel tool. Private call ids never leave this runtime seam.
 */
export function createS2sToolResultBatcher({
  send,
  onError,
  setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer = (timer) => clearTimeout(timer),
}: S2sToolResultBatcherDeps): S2sToolResultBatcher {
  const active = new Set<string>();
  const completed = new Map<string, S2sToolResultItem>();
  let responseDone = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain = Promise.resolve();
  let generation = 0;

  const clearFallback = () => {
    if (fallbackTimer === null) return;
    clearTimer(fallbackTimer);
    fallbackTimer = null;
  };

  const flush = (): Promise<void> => {
    if (active.size > 0 || completed.size === 0) return flushChain;
    clearFallback();
    const batch = [...completed.values()];
    const batchGeneration = generation;
    completed.clear();
    responseDone = false;
    flushChain = flushChain
      .then(async () => {
        // The provider speaks after the batch unless every result in it asked for silence.
        const speak = batch.some((item) => !item.silent);
        for (let index = 0; index < batch.length; index += 1) {
          if (generation !== batchGeneration) return;
          await send(batch[index], speak && index === batch.length - 1);
        }
      })
      .catch((error) => {
        if (generation === batchGeneration) onError?.(error);
      });
    return flushChain;
  };

  const scheduleFallback = () => {
    clearFallback();
    fallbackTimer = setTimer(() => {
      fallbackTimer = null;
      void flush();
    }, S2S_TOOL_RESULT_FALLBACK_MS);
  };

  return {
    begin(callId) {
      if (active.size === 0 && completed.size === 0) responseDone = false;
      clearFallback();
      active.add(callId);
    },

    complete(callId, output, silent = false) {
      if (!active.delete(callId)) return flushChain;
      completed.set(callId, { callId, output, ...(silent && { silent }) });
      if (active.size > 0) return flushChain;
      if (responseDone) return flush();
      scheduleFallback();
      return flushChain;
    },

    markResponseDone() {
      if (active.size === 0 && completed.size === 0) return flushChain;
      responseDone = true;
      return active.size === 0 ? flush() : flushChain;
    },

    reset() {
      generation += 1;
      clearFallback();
      active.clear();
      completed.clear();
      responseDone = false;
    },
  };
}
