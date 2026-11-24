import { canvasParkRetryDelayMs } from "./canvas-viewport-policy";

/**
 * Guarantees a "park" (moving the native WebView off-screen) is eventually delivered even if the
 * IPC that carries it fails. While a blocking overlay is open there are no further geometry events
 * to trigger the normal best-effort re-sync, so a lost park would silently leave the WebView
 * covering the overlay — the original occlusion bug. This controller schedules bounded retries with
 * backoff and reports (once) if they are exhausted.
 *
 * Clock functions are injected so the retry schedule is testable without real timers.
 */
export interface ParkRetryController {
  /** The park landed: cancel any pending retry and reset the attempt budget. */
  onSuccess(): void;
  /** The park IPC rejected: schedule the next retry via `reissue`, or give up if exhausted. */
  onFailure(reissue: () => void): void;
  /** Newer bounds supersede a pending park: drop the retry and reset the budget. */
  cancel(): void;
}

export interface ParkRetryDeps {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  onGiveUp?: () => void;
}

export function createParkRetryController(deps: ParkRetryDeps): ParkRetryController {
  let attempt = 0;
  let timer: number | null = null;

  const clearTimer = () => {
    if (timer != null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  };

  const reset = () => {
    clearTimer();
    attempt = 0;
  };

  return {
    onSuccess: reset,
    cancel: reset,
    onFailure(reissue: () => void): void {
      clearTimer();
      const delay = canvasParkRetryDelayMs(attempt);
      if (delay == null) {
        deps.onGiveUp?.();
        return;
      }
      attempt += 1;
      timer = deps.setTimeout(() => {
        timer = null;
        reissue();
      }, delay);
    },
  };
}
