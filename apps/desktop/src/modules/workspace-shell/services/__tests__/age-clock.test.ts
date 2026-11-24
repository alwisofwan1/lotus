import { describe, expect, it, vi } from "vitest";
import { createAgeClock } from "@/modules/workspace-shell/services/age-clock";

/** A schedule that can be fired by hand, so the tests need no timers. */
function manualSchedule() {
  const handlers: (() => void)[] = [];
  const stops = vi.fn();
  return {
    schedule: (handler: () => void) => {
      handlers.push(handler);
      return () => {
        handlers.splice(handlers.indexOf(handler), 1);
        stops();
      };
    },
    tick: () => handlers.forEach((handler) => handler()),
    running: () => handlers.length,
    stops,
  };
}

describe("the shared age clock", () => {
  it("runs no timer until something needs one", () => {
    // A workspace of resting panes prints no ages, so it must cost no timer.
    const timers = manualSchedule();
    createAgeClock({ schedule: timers.schedule });

    expect(timers.running()).toBe(0);
  });

  it("starts on the first listener and stops with the last", () => {
    const timers = manualSchedule();
    const clock = createAgeClock({ schedule: timers.schedule });

    const first = clock.subscribe(() => {});
    const second = clock.subscribe(() => {});
    expect(timers.running()).toBe(1);

    first();
    expect(timers.running()).toBe(1);
    second();
    expect(timers.running()).toBe(0);
  });

  it("hands back a stored value, not a fresh reading", () => {
    // `getSnapshot` is called during render; reading the clock there would make a render
    // non-idempotent, which is the bug this module exists to avoid.
    let time = 1_000;
    const timers = manualSchedule();
    const clock = createAgeClock({ schedule: timers.schedule, readClock: () => time });
    clock.subscribe(() => {});

    time = 5_000;
    expect(clock.now()).toBe(1_000);

    timers.tick();
    expect(clock.now()).toBe(5_000);
  });

  it("re-stamps when it wakes up, rather than serving an old time", () => {
    let time = 1_000;
    const timers = manualSchedule();
    const clock = createAgeClock({ schedule: timers.schedule, readClock: () => time });

    const stop = clock.subscribe(() => {});
    stop();
    time = 3_600_000;

    clock.subscribe(() => {});
    expect(clock.now()).toBe(3_600_000);
  });

  it("notifies every listener on a tick", () => {
    const timers = manualSchedule();
    const clock = createAgeClock({ schedule: timers.schedule });
    const first = vi.fn();
    const second = vi.fn();
    clock.subscribe(first);
    clock.subscribe(second);

    timers.tick();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
