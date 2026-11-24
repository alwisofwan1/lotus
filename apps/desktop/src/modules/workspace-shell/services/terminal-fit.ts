export interface TerminalBoxSize {
  width: number;
  height: number;
}

/**
 * Whether a terminal is worth fitting right now.
 *
 * Borrowed from bb's terminal view (`ThreadTerminalView.tsx`), which guards every fit with a
 * visible-size check and coalesces the rest per animation frame. Fitting a box with no size makes
 * xterm compute zero columns and reflow its whole buffer the moment the box returns — which reads
 * as the terminal "redrawing badly" rather than as a measurement problem.
 */
export function shouldFitTerminal(size: TerminalBoxSize): boolean {
  return size.width > 0 && size.height > 0;
}

export interface FitSchedulerOptions {
  fit: () => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface FitScheduler {
  /** Asks for a fit on the next frame. Repeat calls before that frame are free. */
  schedule: () => void;
  /** Drops a pending fit — for teardown, so a disposed terminal is never fitted. */
  cancel: () => void;
}

/**
 * One fit per frame, however many times the size changes inside it.
 *
 * A seam drag emits a ResizeObserver entry per pointer move. Fitting on each one re-measures the
 * character grid and repaints the terminal dozens of times a second — the "heavy" feeling while
 * dragging. Only the last size in a frame matters, so that is the only one that gets fitted.
 */
export function createFitScheduler({
  fit,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
}: FitSchedulerOptions): FitScheduler {
  let pending: number | null = null;

  return {
    schedule() {
      if (pending !== null) return;
      pending = requestFrame(() => {
        pending = null;
        fit();
      });
    },
    cancel() {
      if (pending === null) return;
      cancelFrame(pending);
      pending = null;
    },
  };
}

/** Sub-pixel differences are rounding, not a relayout. */
const SETTLE_EPSILON = 1;

/**
 * Whether a measured box has stopped moving.
 *
 * A pane's first measurement arrives mid-layout — the split tree has not sized its children yet,
 * the composer has not claimed its height. xterm fitted to that number computes its rows from a
 * box it is about to stop having, and nothing corrects it until the next resize. That is why
 * dragging the sidebar appeared to "fix" the terminal: the drag was the missing refit.
 *
 * Waiting for the same size twice costs one frame and makes the first fit the right one.
 */
export function hasSettledSize(previous: TerminalBoxSize | null, next: TerminalBoxSize): boolean {
  if (!shouldFitTerminal(next)) return false;
  if (!previous) return false;
  return (
    Math.abs(previous.width - next.width) < SETTLE_EPSILON &&
    Math.abs(previous.height - next.height) < SETTLE_EPSILON
  );
}
