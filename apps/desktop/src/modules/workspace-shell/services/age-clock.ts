/**
 * One clock for every age the shell prints.
 *
 * Three shapes were tried before this one, and the first two are the instructive ones:
 *
 *  - A ticker in the shell that re-rendered the mode. It repaints every terminal in the grid twice
 *    a minute for a number that lives in an 8px span, and the panes are not memoised.
 *  - `Date.now()` read during render, with a per-badge interval to force a repaint. A render that
 *    reads the clock is not idempotent — React may render twice and get two answers — and the
 *    compiler rejects it. Setting state from the effect instead trades one rule for another.
 *
 * So the time lives OUTSIDE React, in a value this module stamps, and components read it through
 * `useSyncExternalStore` — which is exactly the hook for a value that changes on its own. The
 * snapshot is a stored number, so reading it is pure.
 *
 * The interval exists only while something is subscribed: a workspace of resting panes prints no
 * ages, subscribes nothing, and runs no timer.
 */

export interface AgeClock {
  /** Register for ticks. The timer starts with the first listener and stops with the last. */
  subscribe(listener: () => void): () => void;
  /** The last stamped time. Pure: it returns a stored value, it does not read the clock. */
  now(): number;
}

export interface AgeClockOptions {
  tickMs?: number;
  readClock?: () => number;
  /** Injected so tests can drive the tick without timers, and SSR can pass a no-op. */
  schedule?: (handler: () => void, ms: number) => () => void;
}

/**
 * How often the stamp advances.
 *
 * Ages are printed in whole minutes, so anything faster repaints for nothing. Half the smallest
 * unit means a badge is never more than one tick behind the truth.
 */
export const AGE_TICK_MS = 30_000;

const defaultSchedule = (handler: () => void, ms: number): (() => void) => {
  if (typeof globalThis.setInterval !== "function") return () => {};
  const timer = globalThis.setInterval(handler, ms);
  return () => globalThis.clearInterval(timer);
};

export function createAgeClock({
  tickMs = AGE_TICK_MS,
  readClock = () => Date.now(),
  schedule = defaultSchedule,
}: AgeClockOptions = {}): AgeClock {
  const listeners = new Set<() => void>();
  let stamped = readClock();
  let stop: (() => void) | null = null;

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) {
        // Re-stamped on the way in: a clock that has been idle for an hour must not hand its
        // first new reader an hour-old time.
        stamped = readClock();
        stop = schedule(() => {
          stamped = readClock();
          for (const each of listeners) each();
        }, tickMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stop?.();
        stop = null;
      };
    },
    now() {
      return stamped;
    },
  };
}

/** The shared instance every badge reads. */
export const ageClock: AgeClock = createAgeClock();
