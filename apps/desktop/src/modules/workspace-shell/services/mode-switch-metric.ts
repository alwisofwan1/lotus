/**
 * How long a mode switch takes, measured where it actually happens.
 *
 * §M2 asks for this to be MEASURED rather than assumed. The existing harness
 * (`codechat-session-switch.perf.spec.ts`) measures switching SESSIONS inside `/codechat`, and it
 * drives a browser — where there is no PTY and no native chat runtime, so it cannot answer what a
 * mode switch costs in the real window.
 *
 * So the measurement lives in the app: mark when the switch is requested, and stop the clock on
 * the frame that follows the commit. `requestAnimationFrame` fires before the browser paints, so
 * a second nested frame is used — by then the paint that shows the new mode has happened.
 */

export interface ModeSwitchSample {
  from: string;
  to: string;
  ms: number;
  /** True the first time a mode is built, which is the expensive one. */
  firstBuild: boolean;
  /**
   * What Code mode was holding at that moment, as the status pill words it.
   *
   * Carried with the sample so a number can be read against its workspace afterwards: the whole
   * question about the return to Code is whether its cost follows the terminals.
   */
  contents?: string;
}

export type ModeSwitchReporter = (sample: ModeSwitchSample) => void;

export interface ModeSwitchClockOptions {
  now?: () => number;
  scheduleFrame?: (callback: () => void) => void;
  report: ModeSwitchReporter;
}

/**
 * Returns a function to call at the moment a switch is requested. The sample is reported after
 * the paint that follows.
 */
export function createModeSwitchClock({
  now = () => performance.now(),
  scheduleFrame = (callback) => {
    requestAnimationFrame(() => requestAnimationFrame(callback));
  },
  report,
}: ModeSwitchClockOptions) {
  return function markSwitch(
    from: string,
    to: string,
    firstBuild: boolean,
    contents?: string,
  ): void {
    const startedAt = now();
    scheduleFrame(() => {
      report({ from, to, ms: now() - startedAt, firstBuild, contents });
    });
  };
}

/** Percentiles of what was collected, for a one-line summary. */
export function summarizeModeSwitches(samples: readonly ModeSwitchSample[]) {
  const sorted = [...samples].map((sample) => sample.ms).sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];

  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}
