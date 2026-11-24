export interface StreamingSttUploadQueue {
  /** Accept one chunk when active+waiting work remains below the cap. */
  enqueue(chunk: string): boolean;
  /** Resolve only after all accepted chunks are sent; reject on overload/send failure. */
  flush(): Promise<void>;
}

export interface StreamingSttUploadQueueOptions {
  maxPending: number;
  send: (chunk: string) => Promise<void>;
  onFailure?: (error: Error) => void;
}

const UPLOAD_FAILED_PREFIX = "Streaming STT audio upload failed";

export function createStreamingSttUploadQueue(
  options: StreamingSttUploadQueueOptions,
): StreamingSttUploadQueue {
  const maxPending = Math.max(1, Math.floor(options.maxPending));
  const pending: string[] = [];
  const flushWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let active = false;
  let failure: Error | null = null;

  const settleWaiters = () => {
    if (active || pending.length > 0) return;
    const waiters = flushWaiters.splice(0);
    if (failure) waiters.forEach((waiter) => waiter.reject(failure!));
    else waiters.forEach((waiter) => waiter.resolve());
  };

  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    pending.length = 0;
    options.onFailure?.(error);
    if (!active) settleWaiters();
  };

  const pump = () => {
    if (active || failure) {
      settleWaiters();
      return;
    }
    const chunk = pending.shift();
    if (chunk === undefined) {
      settleWaiters();
      return;
    }
    active = true;
    try {
      options.send(chunk).then(
        () => {
          active = false;
          pump();
        },
        (cause) => {
          active = false;
          const detail = cause instanceof Error ? cause.message : String(cause);
          fail(new Error(`${UPLOAD_FAILED_PREFIX}: ${detail}`));
          settleWaiters();
        },
      );
    } catch (cause) {
      active = false;
      const detail = cause instanceof Error ? cause.message : String(cause);
      fail(new Error(`${UPLOAD_FAILED_PREFIX}: ${detail}`));
      settleWaiters();
    }
  };

  return {
    enqueue(chunk) {
      if (failure) return false;
      if ((active ? 1 : 0) + pending.length >= maxPending) {
        fail(new Error("Streaming STT audio upload queue is full; transcription would be incomplete."));
        return false;
      }
      pending.push(chunk);
      pump();
      return true;
    },
    flush() {
      if (failure) return Promise.reject(failure);
      if (!active && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        flushWaiters.push({ resolve, reject });
      });
    },
  };
}
