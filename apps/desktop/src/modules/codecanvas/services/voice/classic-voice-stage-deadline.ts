export interface ClassicVoiceStageDeadlineOptions {
  stage: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

function abortError(stage: string): Error {
  const error = new Error(`${stage} was cancelled.`);
  error.name = "AbortError";
  return error;
}

/** Bound one async stage while detaching cleanly from late provider/model completion. */
export function waitForClassicVoiceStage<T>(
  operation: Promise<T>,
  options: ClassicVoiceStageDeadlineOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => settle(() => reject(abortError(options.stage)));
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`${options.stage} timed out after ${options.timeoutMs} ms.`)));
    }, Math.max(0, Math.floor(options.timeoutMs)));

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}
